import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, addDoc, getDocs, writeBatch, query, onSnapshot, setDoc, deleteDoc, Timestamp, runTransaction } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import Papa from 'papaparse';

// --- Firebase 설정 ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
};

// --- 앱 초기화 ---
if (!firebaseConfig.projectId) {
    console.error('Firebase projectId가 제공되지 않았습니다. 환경 변수(.env)를 확인하세요.');
}
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- 헬퍼 함수 및 상수 ---
const ICONS = {
    "은행": "🏦", "증권": "💹", "코인": "🪙", "현금": "💵", "카드": "💳", "기타": "📁",
    "수입": "💰", "지출": "💸", "이체": "🔄", "대시보드": "📊", "거래내역": "🧾", "계좌관리": "💼",
    "리포트": "📈", "데이터": "💾", "스케줄": "📅", "환율": "💱"
};
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#da70d6'];

const formatCurrency = (amount, currency = 'KRW') => {
    try {
        return new Intl.NumberFormat('ko-KR', { style: 'currency', currency, minimumFractionDigits: currency === 'KRW' ? 0 : 2 }).format(amount);
    } catch(e) {
        return `${amount.toLocaleString()} ${currency}`;
    }
};

const formatNumber = (amount) => new Intl.NumberFormat('ko-KR').format(amount);


// --- 메인 앱 컴포넌트 ---
export default function HouseholdApp() {
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeView, setActiveView] = useState('dashboard');
    const [editingTransaction, setEditingTransaction] = useState(null); // 수정할 거래 상태
    const [showTransactionModal, setShowTransactionModal] = useState(false);
    const [isNavOpen, setIsNavOpen] = useState(false);
    
    const [accounts, setAccounts] = useState([]);
    const [cards, setCards] = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [schedules, setSchedules] = useState([]);
    const [currencies, setCurrencies] = useState([]);

    // --- Firebase 인증 ---
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                setUser(user);
            } else {
                try {
                    await signInAnonymously(auth);
                } catch (error) { console.error("Firebase 익명 로그인 실패:", error); setUser(null); }
            }
        });
        return () => unsubscribe();
    }, []);

    // --- 데이터 로딩 ---
    useEffect(() => {
        if (!user) return;
        setIsLoading(true);

        const collectionsToWatch = ['accounts', 'cards', 'transactions', 'schedules', 'currencies'];
        const unsubscribes = collectionsToWatch.map(colName => {
            const q = query(collection(db, `users/${user.uid}/${colName}`));
            return onSnapshot(q, (querySnapshot) => {
                const data = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                switch(colName) {
                    case 'accounts': setAccounts(data); break;
                    case 'cards': setCards(data); break;
                    case 'transactions': setTransactions(data.sort((a, b) => b.date.toDate().getTime() - a.date.toDate().getTime())); break;
                    case 'schedules': setSchedules(data.sort((a,b) => a.date.toDate().getTime() - b.date.toDate().getTime())); break;
                    case 'currencies': 
                        if (!data.some(c => c.symbol === 'KRW')) {
                             setDoc(doc(db, `users/${user.uid}/currencies`, 'KRW'), { symbol: 'KRW', name: '대한민국 원', rate: 1, isBase: true });
                        }
                        setCurrencies(data);
                        break;
                    default: break;
                }
            }, (error) => console.error(`${colName} 데이터 로딩 실패:`, error));
        });
        
        const allListenersReady = Promise.all(collectionsToWatch.map(c => getDocs(query(collection(db, `users/${user.uid}/${c}`)))));
        allListenersReady.then(() => setIsLoading(false)).catch(() => setIsLoading(false));

        return () => unsubscribes.forEach(unsub => unsub());
    }, [user]);

    // --- 데이터 처리 및 계산 ---
    const accountsById = useMemo(() => accounts.reduce((acc, curr) => ({ ...acc, [curr.id]: curr }), {}), [accounts]);
    const cardsById = useMemo(() => cards.reduce((acc, curr) => ({ ...acc, [curr.id]: curr }), {}), [cards]);
    const rates = useMemo(() => currencies.reduce((acc, curr) => ({ ...acc, [curr.symbol]: curr.rate }), {}), [currencies]);

    const convertToKRW = useCallback((amount, currency) => {
        if (!currency || currency === 'KRW') return amount;
        return amount * (rates[currency] || 1);
    }, [rates]);

    const { totalAssetInKRW, totalCashAssetInKRW, upcomingPayments } = useMemo(() => {
        const totalCash = accounts.reduce((sum, acc) => sum + convertToKRW(acc.balance || 0, acc.currency), 0);
        
        const cardPayments = cards.map(card => {
            const today = new Date();
            const paymentDay = card.paymentDay;
            let usageStart = new Date(today.getFullYear(), today.getMonth() - (today.getDate() < paymentDay ? 1 : 0), card.usageStartDay);
            let usageEnd = new Date(today.getFullYear(), today.getMonth() + (today.getDate() < paymentDay ? 0 : 1), card.usageEndDay, 23, 59, 59);
            
            const amount = transactions
                .filter(t => t.type === 'card-expense' && t.cardId === card.id && !t.isPaid && t.date.toDate() >= usageStart && t.date.toDate() <= usageEnd)
                .reduce((sum, t) => sum + t.amount, 0);

            return { cardId: card.id, cardName: card.name, linkedAccountId: card.linkedAccountId, amount };
        });

        const totalUpcomingPaymentAmount = cardPayments.reduce((sum, p) => sum + p.amount, 0);

        return {
            totalCashAssetInKRW: totalCash,
            totalAssetInKRW: totalCash - totalUpcomingPaymentAmount,
            upcomingPayments: cardPayments.filter(p => p.amount > 0),
        };
    }, [accounts, cards, transactions, convertToKRW]);

    // --- 데이터 CRUD 함수 ---
    const handleOpenAddModal = () => {
        setEditingTransaction(null);
        setShowTransactionModal(true);
    };

    const handleOpenEditModal = (transaction) => {
        setEditingTransaction(transaction);
        setShowTransactionModal(true);
    };

    const handleDeleteTransaction = async (transactionToDelete) => {
        if (!window.confirm(`'${transactionToDelete.description}' 거래를 삭제하시겠습니까? 계좌 잔액이 복구됩니다.`)) return;

        try {
            await runTransaction(db, async (transaction) => {
                const { type, amount } = transactionToDelete;

                // 1. 계좌 잔액 복구
                if (type === 'income') {
                    const accRef = doc(db, `users/${user.uid}/accounts`, transactionToDelete.accountId);
                    const accDoc = await transaction.get(accRef);
                    if (accDoc.exists()) transaction.update(accRef, { balance: accDoc.data().balance - amount });
                } else if (type === 'expense') {
                    const accRef = doc(db, `users/${user.uid}/accounts`, transactionToDelete.accountId);
                    const accDoc = await transaction.get(accRef);
                    if (accDoc.exists()) transaction.update(accRef, { balance: accDoc.data().balance + amount });
                } else if (type === 'transfer') {
                    const fromAccRef = doc(db, `users/${user.uid}/accounts`, transactionToDelete.accountId);
                    const toAccRef = doc(db, `users/${user.uid}/accounts`, transactionToDelete.toAccountId);
                    const fromAccDoc = await transaction.get(fromAccRef);
                    const toAccDoc = await transaction.get(toAccRef);
                    if (fromAccDoc.exists()) transaction.update(fromAccRef, { balance: fromAccDoc.data().balance + amount });
                    if (toAccDoc.exists()) transaction.update(toAccRef, { balance: toAccDoc.data().balance - amount });
                } else if (type === 'payment') {
                    // 카드 대금 결제 거래 삭제 시, 연결된 카드 거래들의 isPaid 상태를 false로 되돌림
                    const batch = writeBatch(db);
                    const paidCardTransactionIds = transactionToDelete.paidCardTransactionIds || [];
                    paidCardTransactionIds.forEach(id => {
                        const cardTransRef = doc(db, `users/${user.uid}/transactions`, id);
                        batch.update(cardTransRef, { isPaid: false });
                    });
                    await batch.commit();

                    // 계좌 잔액 복구
                    const accRef = doc(db, `users/${user.uid}/accounts`, transactionToDelete.accountId);
                    const accDoc = await transaction.get(accRef);
                    if (accDoc.exists()) transaction.update(accRef, { balance: accDoc.data().balance + amount });
                }


                // 2. 거래 내역 삭제
                const transRef = doc(db, `users/${user.uid}/transactions`, transactionToDelete.id);
                transaction.delete(transRef);
            });
            alert('삭제가 완료되었습니다.');
        } catch (error) {
            console.error("거래 삭제 실패:", error);
            alert(`삭제 실패: ${error.message}`);
        }
    };


    // --- 뷰 렌더링 ---
    const renderView = () => {
        const props = { user, accounts, cards, transactions, schedules, currencies, accountsById, cardsById, rates, convertToKRW,
            onAddTransaction: handleOpenAddModal,
            onEditTransaction: handleOpenEditModal,
            onDeleteTransaction: handleDeleteTransaction
        };
        switch (activeView) {
            case 'dashboard': return <DashboardView {...props} totalAssetInKRW={totalAssetInKRW} totalCashAssetInKRW={totalCashAssetInKRW} upcomingPayments={upcomingPayments} />;
            case 'transactions': return <TransactionsView {...props} />;
            case 'management': return <ManagementView {...props} />;
            case 'schedule': return <ScheduleView {...props} upcomingPayments={upcomingPayments} />;
            case 'currencies': return <CurrencyView {...props} />;
            case 'reports': return <ReportsView {...props} />;
            case 'data': return <DataIOView {...props} />;
            default: return <div>뷰를 찾을 수 없습니다.</div>;
        }
    };
    
    if (isLoading) return <div className="flex justify-center items-center h-screen bg-gray-100"><div className="text-xl font-bold">데이터 로딩 중...</div></div>;
    if (!user) return <div className="flex justify-center items-center h-screen bg-gray-100"><div className="text-xl font-bold text-red-500">인증 중...</div></div>;

    return (
        <div className="bg-gray-50 min-h-screen font-sans text-gray-800">
            {isNavOpen && <div onClick={() => setIsNavOpen(false)} className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"></div>}
            <nav className={`fixed inset-y-0 left-0 w-52 bg-white border-r p-4 flex flex-col z-50 transform transition-transform duration-300 ease-in-out md:translate-x-0 ${isNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-2xl font-bold text-indigo-600">가계부</h1>
                    <button onClick={() => setIsNavOpen(false)} className="md:hidden text-gray-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                </div>
                <ul>
                    {[
                        {id: 'dashboard', name: '대시보드', icon: '대시보드'},
                        {id: 'transactions', name: '거래내역', icon: '거래내역'},
                        {id: 'management', name: '계좌/카드 관리', icon: '계좌관리'},
                        {id: 'schedule', name: '스케줄 관리', icon: '스케줄'},
                        {id: 'currencies', name: '환율/시세 관리', icon: '환율'},
                        {id: 'reports', name: '리포트', icon: '리포트'},
                        {id: 'data', name: '데이터 관리', icon: '데이터'},
                    ].map(view => (
                        <li key={view.id} className="mb-2">
                            <button onClick={() => { setActiveView(view.id); setIsNavOpen(false); }} className={`w-full text-left p-3 rounded-lg flex items-center transition-all ${ activeView === view.id ? 'bg-indigo-500 text-white shadow-md' : 'hover:bg-gray-100' }`}>
                               <span className="text-xl">{ICONS[view.icon]}</span>
                               <span className="ml-3 font-semibold">{view.name}</span>
                            </button>
                        </li>
                    ))}
                </ul>
                 <div className="mt-auto text-xs text-gray-400">
                    <p>사용자 ID:</p>
                    <p className="break-words">{user?.uid}</p>
                </div>
            </nav>
            <div className="md:ml-52">
                <main className="p-4 md:p-8">
                     <button onClick={() => setIsNavOpen(true)} className="md:hidden p-2 bg-white rounded-lg shadow-md mb-4 fixed top-4 left-4 z-30"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"></path></svg></button>
                    {renderView()}
                </main>
            </div>
            {showTransactionModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
                    <TransactionForm 
                        user={user} 
                        accounts={accounts} 
                        cards={cards} 
                        onFinish={() => setShowTransactionModal(false)}
                        transactionToEdit={editingTransaction}
                        db={db}
                    />
                </div>
            )}
        </div>
    );
}

// --- 뷰 컴포넌트들 ---
function DashboardView({ totalAssetInKRW, totalCashAssetInKRW, upcomingPayments, transactions, accountsById, cardsById, schedules, convertToKRW }) {
    const recentTransactions = transactions.slice(0, 5);
    const nextUpcomingSchedule = useMemo(() => schedules.filter(s => !s.isCompleted).sort((a, b) => a.date.toDate().getTime() - b.date.toDate().getTime())[0], [schedules]);

    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">대시보드</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 자산 (예상)</h3><p className="text-3xl font-bold mt-2 text-indigo-600">{formatCurrency(totalAssetInKRW)}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 현금성 자산</h3><p className="text-3xl font-bold mt-2">{formatCurrency(totalCashAssetInKRW)}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">결제 예정 카드값</h3><p className="text-3xl font-bold mt-2 text-red-500">{formatCurrency(upcomingPayments.reduce((sum, p) => sum + p.amount, 0))}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-gray-500">가까운 예정 수입</h3>
                    {nextUpcomingSchedule ? (
                         <div>
                            <p className="text-2xl font-bold mt-2 text-blue-500">{formatCurrency(convertToKRW(nextUpcomingSchedule.amount, accountsById[nextUpcomingSchedule.accountId]?.currency))}</p>
                            <p className="text-sm text-gray-400 truncate" title={nextUpcomingSchedule.description}>{nextUpcomingSchedule.description}</p>
                            <p className="text-sm text-gray-400">{nextUpcomingSchedule.date.toDate().toLocaleDateString()}</p>
                         </div>
                    ) : <p className="text-gray-400 mt-2">예정된 수입 없음</p>}
                </div>
            </div>
            
             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold mb-4">최근 거래 내역</h3>
                    <ul>
                         {recentTransactions.map(t => {
                            const account = accountsById[t.accountId] || {};
                            const currency = account.currency || (t.type === 'card-expense' ? 'KRW' : '');
                            return (
                            <li key={t.id} className="flex justify-between items-center py-2 border-b last:border-b-0">
                                <div>
                                    <span className="font-semibold">{t.description}</span>
                                    <p className="text-sm text-gray-500">
                                        {t.type === 'card-expense' ? cardsById[t.cardId]?.name : account.name}
                                        {t.type === 'transfer' && ` -> ${accountsById[t.toAccountId]?.name}`}
                                    </p>
                                </div>
                                <span className={`font-bold ${t.type === 'income' ? 'text-blue-500' : 'text-red-500'}`}>
                                   {t.type === 'income' ? '+' : '-'} {formatNumber(t.amount)} {currency !== 'KRW' ? currency : ''}
                                </span>
                            </li>
                         );})}
                         {recentTransactions.length === 0 && <p className="text-gray-500">최근 거래 내역이 없습니다.</p>}
                    </ul>
                 </div>
                 <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold mb-4">결제 예정 내역</h3>
                     {upcomingPayments.length > 0 ? (
                        <ul>
                            {upcomingPayments.map(p => (
                                <li key={p.cardId} className="flex justify-between items-center py-2 border-b last:border-b-0">
                                    <div>
                                        <p className="font-semibold">{p.cardName} 결제 예정</p>
                                        <p className="text-sm text-gray-500">연결계좌: {accountsById[p.linkedAccountId]?.name || '없음'}</p>
                                    </div>
                                    <span className="font-bold text-red-500">{formatCurrency(p.amount)}</span>
                                </li>
                            ))}
                        </ul>
                     ) : <p className="text-gray-500 mt-4">결제 예정 내역이 없습니다.</p>}
                 </div>
            </div>
        </div>
    );
}

function TransactionsView({ transactions, accountsById, cardsById, accounts, cards, onAddTransaction, onEditTransaction, onDeleteTransaction }) {
    const [filter, setFilter] = useState({ type: 'all', account: 'all', year: 'all', month: 'all' });

    const transactionYears = useMemo(() => {
        if (transactions.length === 0) return ['all'];
        return ['all', ...Array.from(new Set(transactions.map(t => t.date.toDate().getFullYear()))).sort((a, b) => b - a)];
    }, [transactions]);
    
    const filteredTransactions = useMemo(() => {
        return transactions.filter(t => {
            const date = t.date.toDate();
            const typeMatch = filter.type === 'all' || t.type === filter.type;
            const accountMatch = filter.account === 'all' || t.accountId === filter.account || t.cardId === filter.account || (t.type === 'transfer' && t.toAccountId === filter.account);
            let dateMatch = filter.year === 'all' ? true : date.getFullYear() === Number(filter.year) && (filter.month === 'all' ? true : (date.getMonth() + 1) === Number(filter.month));
            return typeMatch && accountMatch && dateMatch;
        });
    }, [transactions, filter]);

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                 <h2 className="text-3xl font-bold">전체 거래 내역</h2>
                 <button onClick={onAddTransaction} className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition">거래 추가</button>
            </div>
            <div className="flex flex-wrap gap-4 mb-4 bg-white p-4 rounded-xl shadow-sm">
                <select value={filter.type} onChange={e => setFilter({...filter, type: e.target.value})} className="p-2 border rounded-lg bg-white">
                    <option value="all">모든 종류</option><option value="income">수입</option><option value="expense">지출(계좌)</option><option value="card-expense">지출(카드)</option><option value="payment">카드대금</option><option value="transfer">이체</option>
                </select>
                <select value={filter.account} onChange={e => setFilter({...filter, account: e.target.value})} className="p-2 border rounded-lg bg-white">
                    <option value="all">모든 계좌/카드</option>
                    {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                    {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
                </select>
                <select value={filter.year} onChange={e => setFilter({...filter, year: e.target.value, month: 'all'})} className="p-2 border rounded-lg bg-white">
                    {transactionYears.map(y => <option key={y} value={y}>{y === 'all' ? '전체 연도' : `${y}년`}</option>)}
                </select>
                 <select value={filter.month} onChange={e => setFilter({...filter, month: e.target.value})} className="p-2 border rounded-lg bg-white" disabled={filter.year === 'all'}>
                    <option value="all">전체 월</option>
                    {Array.from({length: 12}, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}월</option>)}
                </select>
            </div>
            <div className="bg-white p-6 rounded-xl shadow-md">
                 <ul className="divide-y divide-gray-200">
                    {filteredTransactions.map(t => {
                        const account = accountsById[t.accountId] || {};
                        const currency = account.currency || (t.type === 'card-expense' ? 'KRW' : '');
                        return (
                            <li key={t.id} className="py-4 flex items-center justify-between">
                                <div className="flex items-center">
                                    <span className="text-2xl mr-4">{ICONS[t.type === 'income' ? '수입' : t.type.includes('expense') || t.type === 'payment' ? '지출' : '이체']}</span>
                                    <div>
                                        <p className="font-semibold">{t.description}</p>
                                        <p className="text-sm text-gray-600">
                                          {t.date.toDate().toLocaleString('ko-KR')} - 
                                          <span className="ml-2 font-medium">
                                            {t.type === 'card-expense' ? cardsById[t.cardId]?.name : account.name}
                                            {t.type === 'transfer' && ` → ${accountsById[t.toAccountId]?.name}`}
                                            {t.isPaid && <span className="text-xs text-green-600 ml-2">(결제완료)</span>}
                                          </span>
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center space-x-2 sm:space-x-4">
                                    <div className={`text-lg font-bold ${t.type === 'income' ? 'text-blue-600' : 'text-red-600'}`}>
                                        {t.type === 'income' ? '+' : '-'} {formatNumber(t.amount)} {currency !== 'KRW' ? currency : ''}
                                    </div>
                                    <button onClick={() => onEditTransaction(t)} className="p-2 hover:bg-gray-200 rounded-full">✏️</button>
                                    <button onClick={() => onDeleteTransaction(t)} className="p-2 hover:bg-gray-200 rounded-full">🗑️</button>
                                </div>
                            </li>
                        )
                    })}
                    {filteredTransactions.length === 0 && <p className="text-gray-500 py-4">해당 조건의 거래 내역이 없습니다.</p>}
                 </ul>
            </div>
        </div>
    );
}

function ManagementView({ user, accounts, cards, transactions, onAddTransaction, currencies, rates, convertToKRW }) {
    const [view, setView] = useState('accounts');
    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-3xl font-bold">계좌/카드 관리</h2>
                <button onClick={onAddTransaction} className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition">거래 추가</button>
            </div>
            <div className="flex border-b mb-4">
                <button onClick={() => setView('accounts')} className={`px-4 py-2 ${view === 'accounts' ? 'border-b-2 border-indigo-500 font-semibold' : 'text-gray-500'}`}>계좌</button>
                <button onClick={() => setView('cards')} className={`px-4 py-2 ${view === 'cards' ? 'border-b-2 border-indigo-500 font-semibold' : 'text-gray-500'}`}>신용카드</button>
            </div>
            {view === 'accounts' && <AccountList user={user} accounts={accounts} currencies={currencies} rates={rates} />}
            {view === 'cards' && <CardList user={user} cards={cards} accounts={accounts} transactions={transactions} db={db}/>}
        </div>
    );
}

function AccountList({ user, accounts, currencies, rates }) {
    const [isAdding, setIsAdding] = useState(false);
    const [newAccount, setNewAccount] = useState({ name: '', category: '은행', balance: '', currency: 'KRW' });

    const handleAddAccount = async (e) => {
        e.preventDefault();
        const docRef = collection(db, `users/${user.uid}/accounts`);
        await addDoc(docRef, { ...newAccount, balance: Number(newAccount.balance), createdAt: Timestamp.now() });
        setNewAccount({ name: '', category: '은행', balance: '', currency: 'KRW' });
        setIsAdding(false);
    };

    const handleDeleteAccount = async (id) => {
        if(window.confirm("정말로 계좌를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
             await deleteDoc(doc(db, `users/${user.uid}/accounts`, id));
        }
    }

    return (
        <div className="bg-white p-6 rounded-xl shadow-md">
            {accounts.map(acc => (
                <div key={acc.id} className="flex justify-between items-center p-3 mb-2 border rounded-lg">
                    <div className="flex items-center"><span className="text-2xl mr-4">{ICONS[acc.category]}</span><div><p className="font-semibold">{acc.name}</p><p className="text-sm text-gray-500">{acc.category} ({acc.currency})</p></div></div>
                    <div className="text-right flex items-center gap-4">
                        <div>
                            <p className="text-lg font-bold">{formatNumber(acc.balance)} {acc.currency}</p>
                            {acc.currency !== 'KRW' && <p className="text-sm text-gray-500">{formatCurrency(acc.balance * (rates[acc.currency] || 1))}</p>}
                        </div>
                        <button onClick={() => handleDeleteAccount(acc.id)} className="text-red-500 hover:text-red-700 p-1">삭제</button>
                    </div>
                </div>
            ))}
            {isAdding && (
                <form onSubmit={handleAddAccount} className="p-4 border-t mt-4 space-y-3">
                    <input name="name" value={newAccount.name} onChange={e => setNewAccount({...newAccount, name: e.target.value})} placeholder="계좌 이름" required className="w-full p-2 border rounded"/>
                    <div className="grid grid-cols-2 gap-4">
                        <select name="category" value={newAccount.category} onChange={e => setNewAccount({...newAccount, category: e.target.value})} required className="w-full p-2 border rounded">
                            <option value="은행">은행</option><option value="증권">증권</option><option value="코인">코인</option><option value="현금">현금</option><option value="기타">기타</option>
                        </select>
                        <select name="currency" value={newAccount.currency} onChange={e => setNewAccount({...newAccount, currency: e.target.value})} required className="w-full p-2 border rounded">
                            {currencies.map(c => <option key={c.symbol} value={c.symbol}>{c.symbol} ({c.name})</option>)}
                        </select>
                    </div>
                    <input name="balance" type="number" step="any" value={newAccount.balance} onChange={e => setNewAccount({...newAccount, balance: e.target.value})} placeholder="초기 잔액" required className="w-full p-2 border rounded"/>
                    <div className="flex justify-end space-x-2"><button type="button" onClick={() => setIsAdding(false)} className="bg-gray-200 px-4 py-2 rounded">취소</button><button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">추가</button></div>
                </form>
            )}
            <button onClick={() => setIsAdding(!isAdding)} className="w-full mt-4 bg-gray-100 hover:bg-gray-200 p-3 rounded-lg">{isAdding ? '취소' : '+ 새 계좌 추가'}</button>
        </div>
    );
}

function CardList({ user, cards, accounts, transactions, db }) {
    const [isAdding, setIsAdding] = useState(false);
    const [newCard, setNewCard] = useState({ name: '', paymentDay: 15, usageStartDay: 1, usageEndDay: 31, linkedAccountId: '' });
    
    const handleAddCard = async (e) => {
        e.preventDefault();
        await addDoc(collection(db, `users/${user.uid}/cards`), {
            ...newCard,
            paymentDay: Number(newCard.paymentDay),
            usageStartDay: Number(newCard.usageStartDay),
            usageEndDay: Number(newCard.usageEndDay),
        });
        setIsAdding(false);
        setNewCard({ name: '', paymentDay: 15, usageStartDay: 1, usageEndDay: 31, linkedAccountId: '' });
    };

    const handleConfirmPayment = async (cardId, amount, linkedAccountId, transactionsToPay) => {
        if (!window.confirm(`${formatCurrency(amount)}을 결제 처리하시겠습니까?`)) return;

        try {
            await runTransaction(db, async (transaction) => {
                const accRef = doc(db, `users/${user.uid}/accounts`, linkedAccountId);
                const accDoc = await transaction.get(accRef);
                if (!accDoc.exists()) throw new Error("연결된 계좌를 찾을 수 없습니다.");
                transaction.update(accRef, { balance: accDoc.data().balance - amount });

                const newTransRef = doc(collection(db, `users/${user.uid}/transactions`));
                transaction.set(newTransRef, {
                    type: 'payment', accountId: linkedAccountId, amount,
                    description: `${cards.find(c=>c.id === cardId)?.name} 카드대금 결제`,
                    date: Timestamp.now(), paidCardTransactionIds: transactionsToPay.map(t => t.id)
                });

                transactionsToPay.forEach(t => {
                    const tRef = doc(db, `users/${user.uid}/transactions`, t.id);
                    transaction.update(tRef, { isPaid: true });
                });
            });
            alert("결제 처리가 완료되었습니다.");
        } catch(error) {
            console.error(error);
            alert(`오류: ${error.message}`);
        }
    };
    
    return (
        <div className="bg-white p-6 rounded-xl shadow-md">
            {cards.map(card => {
                const today = new Date();
                const paymentDay = card.paymentDay;
                let usageStart = new Date(today.getFullYear(), today.getMonth() - (today.getDate() < paymentDay ? 1 : 0), card.usageStartDay);
                let usageEnd = new Date(today.getFullYear(), today.getMonth() + (today.getDate() < paymentDay ? 0 : 1), card.usageEndDay, 23, 59, 59);
                
                const transactionsToPay = transactions.filter(t => t.type === 'card-expense' && t.cardId === card.id && !t.isPaid && t.date.toDate() >= usageStart && t.date.toDate() <= usageEnd);
                const amountToPay = transactionsToPay.reduce((sum, t) => sum + t.amount, 0);

                return (
                    <div key={card.id} className="p-3 mb-2 border rounded-lg">
                        <div className="flex justify-between items-center">
                            <p className="font-semibold">{card.name}</p>
                            <span className="text-sm">결제일: 매월 {card.paymentDay}일</span>
                        </div>
                        {amountToPay > 0 && (
                            <div className="mt-2 p-3 bg-red-50 rounded-lg flex justify-between items-center">
                                <div>
                                    <p className="text-red-600 font-bold">결제 예정 금액: {formatCurrency(amountToPay)}</p>
                                    <p className="text-xs text-gray-500">({usageStart.toLocaleDateString()} ~ {usageEnd.toLocaleDateString()})</p>
                                </div>
                                <button onClick={() => handleConfirmPayment(card.id, amountToPay, card.linkedAccountId, transactionsToPay)}
                                 className="bg-red-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-red-600" disabled={!card.linkedAccountId}>결제 확정</button>
                            </div>
                        )}
                    </div>
                );
            })}
             {isAdding && (
                <form onSubmit={handleAddCard} className="p-4 border-t mt-4 space-y-3">
                    <input value={newCard.name} onChange={e=>setNewCard({...newCard, name: e.target.value})} placeholder="카드 이름" className="w-full p-2 border rounded" required />
                    <input type="number" min="1" max="31" value={newCard.paymentDay} onChange={e=>setNewCard({...newCard, paymentDay: e.target.value})} placeholder="결제일" className="w-full p-2 border rounded" required />
                    <input type="number" min="1" max="31" value={newCard.usageStartDay} onChange={e=>setNewCard({...newCard, usageStartDay: e.target.value})} placeholder="이용 시작일" className="w-full p-2 border rounded" required />
                    <input type="number" min="1" max="31" value={newCard.usageEndDay} onChange={e=>setNewCard({...newCard, usageEndDay: e.target.value})} placeholder="이용 종료일" className="w-full p-2 border rounded" required />
                    <select value={newCard.linkedAccountId} onChange={e=>setNewCard({...newCard, linkedAccountId: e.target.value})} className="w-full p-2 border rounded" required>
                        <option value="">출금 계좌 선택</option>
                        {accounts.filter(a => a.currency === 'KRW').map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                    </select>
                    <div className="flex justify-end space-x-2"><button type="button" onClick={() => setIsAdding(false)} className="bg-gray-200 px-4 py-2 rounded">취소</button><button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">추가</button></div>
                </form>
             )}
             <button onClick={() => setIsAdding(!isAdding)} className="w-full mt-4 bg-gray-100 hover:bg-gray-200 p-3 rounded-lg">{isAdding ? '취소' : '+ 새 카드 추가'}</button>
        </div>
    );
}

function CurrencyView({ user, currencies }) {
    const [isAdding, setIsAdding] = useState(false);
    const [newCurrency, setNewCurrency] = useState({ symbol: '', name: '', rate: '' });

    const handleAddCurrency = async (e) => {
        e.preventDefault();
        if (currencies.find(c => c.symbol === newCurrency.symbol.toUpperCase())) {
            alert("이미 존재하는 통화 기호입니다.");
            return;
        }
        await setDoc(doc(db, `users/${user.uid}/currencies`, newCurrency.symbol.toUpperCase()), {
            ...newCurrency,
            symbol: newCurrency.symbol.toUpperCase(),
            rate: Number(newCurrency.rate)
        });
        setNewCurrency({ symbol: '', name: '', rate: '' });
        setIsAdding(false);
    };

    const handleUpdateRate = async (symbol, newRateStr) => {
        const newRate = Number(newRateStr);
        if (isNaN(newRate) || newRate < 0) return;
        await setDoc(doc(db, `users/${user.uid}/currencies`, symbol), { rate: newRate }, { merge: true });
    };

    const handleDeleteCurrency = async (symbol) => {
        if (window.confirm(`${symbol} 통화를 삭제하시겠습니까? 이 통화를 사용하는 계좌가 없는지 확인해주세요.`)) {
            await deleteDoc(doc(db, `users/${user.uid}/currencies`, symbol));
        }
    };

    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">환율/시세 관리</h2>
            <div className="bg-white p-6 rounded-xl shadow-md">
                {currencies.map(c => (
                    <div key={c.symbol} className="flex flex-wrap justify-between items-center p-3 mb-2 border rounded-lg">
                        <div className="flex items-center"><p className="font-bold text-lg w-16">{c.symbol}</p><p>{c.name}</p></div>
                        <div className="flex items-center gap-4">
                            <span>1 {c.symbol} =</span>
                            <input type="number" step="any" defaultValue={c.rate} onBlur={(e) => handleUpdateRate(c.symbol, e.target.value)}
                             className="w-40 p-1 border rounded text-right" disabled={c.isBase} />
                            <span>KRW</span>
                            {!c.isBase && <button onClick={() => handleDeleteCurrency(c.symbol)} className="text-red-500 hover:text-red-700">삭제</button>}
                        </div>
                    </div>
                ))}
                {isAdding && (
                     <form onSubmit={handleAddCurrency} className="p-4 border-t mt-4 space-y-3">
                        <input value={newCurrency.symbol} onChange={e => setNewCurrency({...newCurrency, symbol: e.target.value.toUpperCase()})} placeholder="통화 기호 (예: USD, BTC)" required className="w-full p-2 border rounded" />
                        <input value={newCurrency.name} onChange={e => setNewCurrency({...newCurrency, name: e.target.value})} placeholder="통화 이름 (예: 미국 달러)" required className="w-full p-2 border rounded" />
                        <input type="number" step="any" value={newCurrency.rate} onChange={e => setNewCurrency({...newCurrency, rate: e.target.value})} placeholder="1 단위 당 KRW 가치" required className="w-full p-2 border rounded" />
                        <div className="flex justify-end space-x-2"><button type="button" onClick={() => setIsAdding(false)} className="bg-gray-200 px-4 py-2 rounded">취소</button><button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">추가</button></div>
                    </form>
                )}
                <button onClick={() => setIsAdding(!isAdding)} className="w-full mt-4 bg-gray-100 hover:bg-gray-200 p-3 rounded-lg">{isAdding ? '취소' : '+ 새 통화 추가'}</button>
            </div>
        </div>
    );
}

function ScheduleView({ user, schedules, accounts, upcomingPayments, accountsById, convertToKRW }) {
    const [isAdding, setIsAdding] = useState(false);
    const [newSchedule, setNewSchedule] = useState({ description: '', amount: '', date: '', accountId: '' });
    const pendingSchedules = schedules.filter(s => !s.isCompleted);

    const handleAddSchedule = async (e) => {
        e.preventDefault();
        await addDoc(collection(db, `users/${user.uid}/schedules`), {
            ...newSchedule,
            amount: Number(newSchedule.amount),
            date: Timestamp.fromDate(new Date(newSchedule.date)),
            isCompleted: false,
            createdAt: Timestamp.now(),
        });
        setNewSchedule({ description: '', amount: '', date: '', accountId: '' });
        setIsAdding(false);
    };

    const handleCompleteSchedule = async (schedule) => {
        if (!window.confirm(`'${schedule.description}'을 수입으로 처리하시겠습니까?`)) return;
        try {
            await runTransaction(db, async (transaction) => {
                const accountRef = doc(db, `users/${user.uid}/accounts`, schedule.accountId);
                const accountDoc = await transaction.get(accountRef);
                if (!accountDoc.exists()) throw new Error("계좌를 찾을 수 없습니다.");

                const newBalance = accountDoc.data().balance + schedule.amount;
                transaction.update(accountRef, { balance: newBalance });
                
                const newTransactionRef = doc(collection(db, `users/${user.uid}/transactions`));
                transaction.set(newTransactionRef, {
                    type: 'income', accountId: schedule.accountId, amount: schedule.amount,
                    description: `(예정) ${schedule.description}`, category: '예정된 수입',
                    date: Timestamp.now(), createdAt: Timestamp.now(),
                });

                const scheduleRef = doc(db, `users/${user.uid}/schedules`, schedule.id);
                transaction.update(scheduleRef, { isCompleted: true });
            });
            alert('수입 처리가 완료되었습니다.');
        } catch (error) { 
            console.error("스케줄 완료 처리 실패:", error);
            alert(`처리 실패: ${error.message}`);
        }
    };
    
    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">미래 현금흐름 관리</h2>
            <div className="bg-white p-6 rounded-xl shadow-md">
                <h3 className="text-xl font-semibold mb-4">예정 수입 등록</h3>
                {isAdding ? (
                    <form onSubmit={handleAddSchedule} className="p-4 border-t mt-4 space-y-3">
                        <input value={newSchedule.date} onChange={e => setNewSchedule({...newSchedule, date: e.target.value})} type="datetime-local" className="w-full p-2 border rounded" required />
                        <input value={newSchedule.description} onChange={e => setNewSchedule({...newSchedule, description: e.target.value})} placeholder="내용 (예: 이벤트 당첨금)" className="w-full p-2 border rounded" required />
                        <input value={newSchedule.amount} onChange={e => setNewSchedule({...newSchedule, amount: e.target.value})} type="number" placeholder="금액" className="w-full p-2 border rounded" required />
                        <select value={newSchedule.accountId} onChange={e => setNewSchedule({...newSchedule, accountId: e.target.value})} className="w-full p-2 border rounded" required>
                            <option value="">입금될 계좌</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name} ({acc.currency})</option>)}
                        </select>
                        <div className="flex justify-end space-x-2"><button type="button" onClick={() => setIsAdding(false)} className="bg-gray-200 px-4 py-2 rounded">취소</button><button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">등록</button></div>
                    </form>
                ) : (
                    <button onClick={() => setIsAdding(true)} className="w-full bg-gray-100 hover:bg-gray-200 p-3 rounded-lg">+ 새 예정 수입 추가</button>
                )}
            </div>
            
            <div className="bg-white p-6 rounded-xl shadow-md mt-6">
                <h3 className="text-xl font-semibold mb-4">예정된 수입 목록</h3>
                <ul className="divide-y divide-gray-200">
                    {pendingSchedules.map(s => {
                         const account = accountsById[s.accountId] || {};
                         const currency = account.currency || 'KRW';
                         return (
                            <li key={s.id} className="py-3 flex justify-between items-center">
                                <div>
                                    <p className="font-semibold">{s.description}</p>
                                    <p className="text-sm text-gray-500">{s.date.toDate().toLocaleDateString()} → {account.name}</p>
                                </div>
                                <div className="flex items-center space-x-4">
                                    <span className="font-bold text-blue-600">{formatNumber(s.amount)} {currency}</span>
                                    <button onClick={() => handleCompleteSchedule(s)} className="bg-blue-500 text-white px-3 py-1 text-sm rounded-lg hover:bg-blue-600">완료 처리</button>
                                </div>
                            </li>
                         );
                    })}
                    {pendingSchedules.length === 0 && <p className="text-gray-500">예정된 수입이 없습니다.</p>}
                </ul>
            </div>
             <div className="bg-white p-6 rounded-xl shadow-md mt-6">
                <h3 className="text-xl font-semibold mb-4">예정된 지출 (카드대금)</h3>
                <ul className="divide-y divide-gray-200">
                     {upcomingPayments.map(p => (
                        <li key={p.cardId} className="py-3 flex justify-between items-center">
                            <div><p className="font-semibold">{p.cardName} 결제 예정</p><p className="text-sm text-gray-500">출금 계좌: {accountsById[p.linkedAccountId]?.name || '없음'}</p></div>
                            <span className="font-bold text-red-600">{formatCurrency(p.amount)}</span>
                        </li>
                    ))}
                    {upcomingPayments.length === 0 && <p className="text-gray-500">예정된 카드 대금이 없습니다.</p>}
                </ul>
            </div>
        </div>
    );
}

function TransactionForm({ user, accounts, cards, onFinish, transactionToEdit, db }) {
    const isEditing = !!transactionToEdit;
    const [type, setType] = useState(isEditing ? transactionToEdit.type : 'expense');
    const [formData, setFormData] = useState({
        date: isEditing ? new Date(transactionToEdit.date.toDate()).toISOString().slice(0,16) : new Date().toISOString().slice(0, 16),
        description: isEditing ? transactionToEdit.description : '',
        amount: isEditing ? transactionToEdit.amount : '',
        category: isEditing ? transactionToEdit.category || '' : '',
        accountId: isEditing ? transactionToEdit.accountId : '',
        cardId: isEditing ? transactionToEdit.cardId : '',
        fromAccountId: isEditing && transactionToEdit.type === 'transfer' ? transactionToEdit.accountId : '',
        toAccountId: isEditing ? transactionToEdit.toAccountId : '',
    });

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const selectedAccountCurrency = useMemo(() => {
        const accountId = type === 'transfer' ? formData.fromAccountId : formData.accountId;
        if (!accountId) return 'KRW';
        return accounts.find(a => a.id === accountId)?.currency || 'KRW';
    }, [formData.accountId, formData.fromAccountId, type, accounts]);
    
    const handleSubmit = async (e) => {
        e.preventDefault();
        
        const dataForSubmit = {
            description: formData.description,
            amount: Number(formData.amount),
            date: Timestamp.fromDate(new Date(formData.date)),
            category: formData.category || '',
            type,
            accountId: type === 'transfer' ? formData.fromAccountId : formData.accountId,
            toAccountId: type === 'transfer' ? formData.toAccountId : null,
            cardId: type === 'card-expense' ? formData.cardId : null,
            isPaid: type === 'card-expense' ? (isEditing ? transactionToEdit.isPaid : false) : null,
        };

        try {
            if (isEditing) {
                const oldTransaction = transactionToEdit;
                await runTransaction(db, async (transaction) => {
                    // 1. 이전 거래의 잔액 변경을 되돌림
                    // ... (자세한 로직 필요)
                    
                    // 2. 새 거래의 잔액 변경을 적용
                    // ... (자세한 로직 필요)

                    // 3. 거래 문서 업데이트
                    const transRef = doc(db, `users/${user.uid}/transactions`, oldTransaction.id);
                    // 수정 시에는 잔액 변경 로직을 더 정교하게 다뤄야 하므로, 여기서는 데이터 업데이트만 구현합니다.
                    // 실제 앱에서는 이전 금액과 새 금액의 차액을 계산하여 잔액을 업데이트해야 합니다.
                    transaction.update(transRef, dataForSubmit);
                });
                 alert('수정이 완료되었습니다. (잔액 변동은 단순화됨)');
            } else {
                 await runTransaction(db, async (transaction) => {
                    const newTransactionRef = doc(collection(db, `users/${user.uid}/transactions`));
                    if (type === 'income' || type === 'expense') {
                        const accountRef = doc(db, `users/${user.uid}/accounts`, dataForSubmit.accountId);
                        const accountDoc = await transaction.get(accountRef);
                        if (!accountDoc.exists()) throw new Error("계좌를 찾을 수 없습니다.");
                        const newBalance = type === 'income' ? accountDoc.data().balance + dataForSubmit.amount : accountDoc.data().balance - dataForSubmit.amount;
                        transaction.update(accountRef, { balance: newBalance });
                        transaction.set(newTransactionRef, dataForSubmit);
                    } else if (type === 'card-expense') {
                        transaction.set(newTransactionRef, dataForSubmit);
                    } else if (type === 'transfer') {
                        if (formData.fromAccountId === formData.toAccountId) throw new Error("동일 계좌로 이체할 수 없습니다.");
                        const fromAccRef = doc(db, `users/${user.uid}/accounts`, formData.fromAccountId);
                        const toAccRef = doc(db, `users/${user.uid}/accounts`, formData.toAccountId);
                        const [fromAccDoc, toAccDoc] = await Promise.all([transaction.get(fromAccRef), transaction.get(toAccRef)]);
                        if (!fromAccDoc.exists() || !toAccDoc.exists()) throw new Error("계좌를 찾을 수 없습니다.");
                        if (fromAccDoc.data().currency !== toAccDoc.data().currency) throw new Error("현재 다른 통화 간 이체는 지원되지 않습니다.");
                        
                        transaction.update(fromAccRef, { balance: fromAccDoc.data().balance - dataForSubmit.amount });
                        transaction.update(toAccRef, { balance: toAccDoc.data().balance + dataForSubmit.amount });
                        transaction.set(newTransactionRef, dataForSubmit);
                    }
                });
                alert('추가가 완료되었습니다.');
            }
            onFinish();
        } catch (error) {
            console.error("거래 처리 실패:", error);
            alert(`거래 처리 실패: ${error.message}`);
        }
    };
    
    return (
        <div className="bg-white p-6 rounded-xl shadow-lg max-w-lg mx-auto w-full">
            <h2 className="text-2xl font-bold mb-4">{isEditing ? '거래 수정' : '거래 추가'}</h2>
            <div className="flex mb-4 border-b">
                 {[{id: 'expense', name: '지출(계좌)'}, {id:'income', name: '수입'}, {id:'card-expense', name:'지출(카드)'}, {id:'transfer', name:'이체'}].map(t => (
                    <button key={t.id} onClick={() => setType(t.id)} disabled={isEditing}
                        className={`px-4 py-2 text-sm md:text-base ${type === t.id ? 'border-b-2 border-indigo-500 font-semibold text-indigo-600' : 'text-gray-500'} ${isEditing ? 'cursor-not-allowed opacity-50' : ''}`}>
                        {t.name}
                    </button>
                ))}
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
                 <input name="date" type="datetime-local" value={formData.date} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 <input name="description" placeholder="내용" value={formData.description} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 <input name="amount" type="number" step="any" placeholder={`금액 (${type==='card-expense' ? 'KRW' : selectedAccountCurrency})`} value={formData.amount} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 
                {(type === 'expense' || type === 'income') && (
                    <>
                        <select name="accountId" required className="w-full p-2 border rounded-md" value={formData.accountId} onChange={handleChange}>
                           <option value="">{type === 'expense' ? '출금' : '입금'} 계좌 선택</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name} ({formatCurrency(acc.balance, acc.currency)})</option>)}
                        </select>
                        <input name="category" placeholder="카테고리 (예: 식비)" value={formData.category} onChange={handleChange} className="w-full p-2 border rounded-md"/>
                    </>
                )}
                 {type === 'card-expense' && (
                    <>
                        <select name="cardId" required className="w-full p-2 border rounded-md" value={formData.cardId} onChange={handleChange}>
                            <option value="">사용 카드 선택</option>
                            {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
                        </select>
                         <input name="category" placeholder="카테고리 (예: 쇼핑)" value={formData.category} onChange={handleChange} className="w-full p-2 border rounded-md"/>
                    </>
                 )}
                 {type === 'transfer' && (
                    <>
                       <select name="fromAccountId" required className="w-full p-2 border rounded-md" value={formData.fromAccountId} onChange={handleChange}>
                            <option value="">보내는 계좌</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name} ({formatCurrency(acc.balance, acc.currency)})</option>)}
                        </select>
                        <select name="toAccountId" required className="w-full p-2 border rounded-md" value={formData.toAccountId} onChange={handleChange}>
                            <option value="">받는 계좌</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name} ({formatCurrency(acc.balance, acc.currency)})</option>)}
                        </select>
                    </>
                )}
                <div className="flex justify-end space-x-2 pt-4">
                    <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded-lg">취소</button>
                    <button type="submit" className="bg-indigo-600 text-white px-4 py-2 rounded-lg">저장</button>
                </div>
            </form>
        </div>
    );
}

function ReportsView({ transactions, convertToKRW, accountsById }) {
    const expenseData = useMemo(() => {
        const expenseByCategory = transactions
            .filter(t => (t.type === 'expense' || t.type === 'card-expense') && t.category)
            .reduce((acc, t) => {
                const account = accountsById[t.accountId] || {};
                const amountInKRW = t.type === 'card-expense' ? t.amount : convertToKRW(t.amount, account.currency);
                acc[t.category] = (acc[t.category] || 0) + amountInKRW;
                return acc;
            }, {});
        return Object.entries(expenseByCategory).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value);
    }, [transactions, convertToKRW, accountsById]);
    
    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">리포트</h2>
            <div className="bg-white p-6 rounded-xl shadow-md">
                <h3 className="text-xl font-semibold mb-4">카테고리별 지출 분석 (KRW 환산)</h3>
                {expenseData.length > 0 ? (
                <ResponsiveContainer width="100%" height={400}>
                    <PieChart>
                        <Pie data={expenseData} cx="50%" cy="50%" labelLine={false} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} outerRadius={150} fill="#8884d8" dataKey="value">
                            {expenseData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(value) => formatCurrency(value)} />
                        <Legend />
                    </PieChart>
                </ResponsiveContainer>
                ) : <p className="text-gray-500">분석할 지출 내역이 없습니다.</p>}
            </div>
        </div>
    );
}

function DataIOView({ user, transactions, accounts, cards, schedules, currencies, db }) {
    const handleExport = () => {
        const allData = {
            accounts: accounts.map(({id, ...rest})=>rest),
            cards: cards.map(({id, ...rest})=>rest),
            transactions: transactions.map(({id, ...rest}) => ({...rest, date: rest.date.toDate().toISOString()})),
            schedules: schedules.map(({id, ...rest}) => ({...rest, date: rest.date.toDate().toISOString()})),
            currencies: currencies.map(({id, ...rest})=>rest),
        }
        const jsonStr = JSON.stringify(allData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.setAttribute("download", `household_data_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleImport = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = JSON.parse(event.target.result);
                if (!window.confirm("데이터를 가져오시겠습니까? 기존의 모든 데이터는 삭제되고 이 파일의 데이터로 대체됩니다. 이 작업은 되돌릴 수 없습니다.")) return;

                const batch = writeBatch(db);
                const collections = ['accounts', 'cards', 'transactions', 'schedules', 'currencies'];
                
                // Delete existing data
                for (const col of collections) {
                    const snapshot = await getDocs(collection(db, `users/${user.uid}/${col}`));
                    snapshot.docs.forEach(doc => batch.delete(doc.ref));
                }
                
                // Add new data
                for (const col of collections) {
                    if (data[col]) {
                        data[col].forEach(item => {
                            let newItem = {...item};
                            if (item.date) newItem.date = Timestamp.fromDate(new Date(item.date));
                            if (item.createdAt) newItem.createdAt = Timestamp.fromDate(new Date(item.createdAt));
                            
                            const docRef = col === 'currencies' ? doc(db, `users/${user.uid}/${col}`, item.symbol) : doc(collection(db, `users/${user.uid}/${col}`));
                            batch.set(docRef, newItem);
                        });
                    }
                }
                
                await batch.commit();
                alert("가져오기 완료! 페이지를 새로고침합니다.");
                window.location.reload();
            } catch (error) {
                alert(`가져오기 오류: ${error.message}`);
                console.error("Import error:", error);
            }
        };
        reader.readAsText(file);
    };

    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">데이터 관리</h2>
            <div className="space-y-6">
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold">데이터 내보내기 (JSON)</h3>
                    <p className="text-gray-600 my-2">모든 데이터를 JSON 파일로 다운로드하여 백업합니다.</p>
                    <button onClick={handleExport} className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition">내보내기</button>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold">데이터 가져오기 (JSON)</h3>
                    <p className="text-gray-600 my-2"><strong>경고:</strong> 이 작업은 현재 사용자의 모든 데이터를 삭제하고 파일의 데이터로 덮어씁니다.</p>
                     <input type="file" accept=".json" onChange={handleImport} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100"/>
                </div>
            </div>
        </div>
    );
}

