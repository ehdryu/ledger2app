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
                        db={db} // Pass db for transactions
                    />
                </div>
            )}
        </div>
    );
}

// --- 뷰 컴포넌트들 ---
function TransactionsView({ transactions, accountsById, cardsById, onAddTransaction, onEditTransaction, onDeleteTransaction }) {
    const [filter, setFilter] = useState({ type: 'all', account: 'all', year: 'all', month: 'all' });
    
    // ... 필터링 로직은 이전과 동일 ...
    const filteredTransactions = transactions.filter(t => { /* ... */ return true; });

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                 <h2 className="text-3xl font-bold">전체 거래 내역</h2>
                 <button onClick={onAddTransaction} className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition">거래 추가</button>
            </div>
            {/* ... 필터 UI는 이전과 동일 ... */}
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
                                          <span className="ml-2 font-medium">{t.type === 'card-expense' ? cardsById[t.cardId]?.name : account.name}
                                            {t.type === 'transfer' && ` → ${accountsById[t.toAccountId]?.name}`}
                                          </span>
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center space-x-4">
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

// AddTransactionForm을 TransactionForm으로 일반화
function TransactionForm({ user, accounts, cards, onFinish, transactionToEdit, db }) {
    const isEditing = !!transactionToEdit;
    const [type, setType] = useState(isEditing ? transactionToEdit.type : 'expense');
    const [formData, setFormData] = useState({
        date: isEditing ? new Date(transactionToEdit.date.toDate()).toISOString().slice(0,16) : new Date().toISOString().slice(0, 16),
        description: isEditing ? transactionToEdit.description : '',
        amount: isEditing ? transactionToEdit.amount : '',
        category: isEditing ? transactionToEdit.category : '',
        accountId: isEditing ? transactionToEdit.accountId : '',
        cardId: isEditing ? transactionToEdit.cardId : '',
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
        
        const transactionData = {
            ...formData,
            amount: Number(formData.amount),
            date: Timestamp.fromDate(new Date(formData.date)),
            type,
        };
        
        try {
            if (isEditing) {
                // 수정 로직 (복잡하므로 단순화된 예시)
                const oldTransaction = transactionToEdit;
                await runTransaction(db, async (transaction) => {
                    // 1. 이전 거래의 잔액 변경을 되돌림
                    // ...
                    // 2. 새 거래의 잔액 변경을 적용
                    // ...
                    // 3. 거래 문서 업데이트
                    const transRef = doc(db, `users/${user.uid}/transactions`, oldTransaction.id);
                    transaction.update(transRef, transactionData);
                });
                 alert('수정이 완료되었습니다.');
            } else {
                // 추가 로직
                 await runTransaction(db, async (transaction) => {
                    const newTransactionRef = doc(collection(db, `users/${user.uid}/transactions`));
                    if (type === 'income' || type === 'expense') {
                        const accountRef = doc(db, `users/${user.uid}/accounts`, transactionData.accountId);
                        const accountDoc = await transaction.get(accountRef);
                        if (!accountDoc.exists()) throw new Error("계좌를 찾을 수 없습니다.");
                        const newBalance = type === 'income' ? accountDoc.data().balance + transactionData.amount : accountDoc.data().balance - transactionData.amount;
                        transaction.update(accountRef, { balance: newBalance });
                        transaction.set(newTransactionRef, transactionData);
                    } else if (type === 'card-expense') {
                        transaction.set(newTransactionRef, { ...transactionData, isPaid: false });
                    } else if (type === 'transfer') {
                        // ... 이전과 동일한 이체 로직 ...
                         if (formData.accountId === formData.toAccountId) throw new Error("동일 계좌 이체 불가");
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
                 {/* ... 타입 선택 버튼 ... */}
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
                 <input name="date" type="datetime-local" value={formData.date} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 <input name="description" placeholder="내용" value={formData.description} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 <input name="amount" type="number" step="any" placeholder={`금액 (${type==='card-expense' ? 'KRW' : selectedAccountCurrency})`} value={formData.amount} onChange={handleChange} required className="w-full p-2 border rounded-md"/>
                 {/* ... 나머지 폼 요소 ... */}
                <div className="flex justify-end space-x-2 pt-4">
                    <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded-lg">취소</button>
                    <button type="submit" className="bg-indigo-600 text-white px-4 py-2 rounded-lg">저장</button>
                </div>
            </form>
        </div>
    );
}

// 다른 뷰 컴포넌트들 (Dashboard, Management, Schedule, Currency, Reports, DataIO)은
// 이전 코드와 거의 동일하거나, props 변경에 맞춰 조금씩 수정됩니다.
// 예시로 ScheduleView만 구현합니다.
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
        // ... 이전과 동일한 로직 ...
    };
    
    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">미래 현금흐름 관리</h2>
            {/* ... 스케줄 추가 폼 ... */}
            <div className="bg-white p-6 rounded-xl shadow-md mt-6">
                <h3 className="text-xl font-semibold mb-4">예정된 수입</h3>
                <ul className="divide-y divide-gray-200">
                    {pendingSchedules.map(s => {
                         const account = accountsById[s.accountId] || {};
                         const currency = account.currency || 'KRW';
                         return (
                            <li key={s.id} className="py-3 flex justify-between items-center">
                                {/* ... 내용 표시 ... */}
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
// ... 나머지 컴포넌트 ...
