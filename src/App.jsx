import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, addDoc, getDocs, writeBatch, query, onSnapshot, setDoc, deleteDoc, Timestamp, runTransaction } from 'firebase/firestore';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, browserLocalPersistence, setPersistence } from 'firebase/auth';
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
    "은행": "🏦", "증권": "💹", "코인": "🪙", "현금": "💵", "카드": "💳", "기타": "�",
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

// --- 로그인 화면 컴포넌트 ---
function LoginScreen({ onGoogleSignIn }) {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
            <div className="p-8 bg-white rounded-2xl shadow-xl text-center">
                <h1 className="text-4xl font-bold text-indigo-600 mb-4">가계부</h1>
                <p className="text-gray-600 mb-8">데이터를 안전하게 동기화하려면 로그인하세요.</p>
                <button
                    onClick={onGoogleSignIn}
                    className="flex items-center justify-center w-full px-6 py-3 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
                >
                    <svg className="w-6 h-6 mr-3" viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                        <path fill="none" d="M0 0h48v48H0z"></path>
                    </svg>
                    <span className="font-semibold text-gray-700">Google 계정으로 로그인</span>
                </button>
            </div>
        </div>
    );
}


// --- 메인 앱 컴포넌트 ---
export default function HouseholdApp() {
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeView, setActiveView] = useState('dashboard');
    const [editingTransaction, setEditingTransaction] = useState(null); 
    const [editingSchedule, setEditingSchedule] = useState(null);
    const [showTransactionModal, setShowTransactionModal] = useState(false);
    const [showScheduleModal, setShowScheduleModal] = useState(false);
    const [isNavOpen, setIsNavOpen] = useState(false);
    const [transactionFilter, setTransactionFilter] = useState({ type: 'all', account: 'all', year: 'all', month: 'all', category: 'all', search: '' });
    
    const [accounts, setAccounts] = useState([]);
    const [cards, setCards] = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [schedules, setSchedules] = useState([]);
    const [currencies, setCurrencies] = useState([]);
    const [categories, setCategories] = useState([]);
    const [memos, setMemos] = useState([]);

    // --- Firebase 인증 ---
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                setUser(currentUser);
            } else {
                setUser(null);
            }
            setIsLoading(false);
        });
        return () => unsubscribe();
    }, []);
    
    // --- 데이터 로딩 ---
    useEffect(() => {
        if (!user || user.isAnonymous) return;

        const collectionsToWatch = ['accounts', 'cards', 'transactions', 'schedules', 'currencies', 'categories', 'memos'];
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
                    case 'categories': setCategories(data.sort((a,b) => a.name.localeCompare(b.name))); break;
                    case 'memos': setMemos(data.sort((a,b) => b.createdAt?.toDate().getTime() - a.createdAt?.toDate().getTime())); break;
                    default: break;
                }
            }, (error) => console.error(`${colName} 데이터 로딩 실패:`, error));
        });
        
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

    const accountsWithCalculatedBalances = useMemo(() => {
        return accounts.map(account => {
            const balances = {};
            
            if (account.initialBalance) {
                balances[account.currency] = account.initialBalance;
            }

            transactions.forEach(t => {
                const currency = t.originalCurrency || accountsById[t.accountId]?.currency || 'KRW';
                const amount = t.originalAmount ?? t.amount;

                if (t.accountId === account.id) {
                    if (t.type === 'income') balances[currency] = (balances[currency] || 0) + amount;
                    if (t.type === 'expense') balances[currency] = (balances[currency] || 0) - amount;
                }
                if (t.type === 'transfer') {
                    if (t.accountId === account.id) balances[currency] = (balances[currency] || 0) - amount;
                    if (t.toAccountId === account.id) balances[currency] = (balances[currency] || 0) + amount;
                }
            });
            
            let totalKRW = 0;
            Object.entries(balances).forEach(([currency, amount]) => {
                totalKRW += convertToKRW(amount, currency);
            });

            return { ...account, balances, totalKRW };
        });
    }, [accounts, transactions, rates, convertToKRW, accountsById]);

    const { totalAssetInKRW, totalCashAssetInKRW, upcomingPayments, assetsByCurrency } = useMemo(() => {
        const totalCash = accountsWithCalculatedBalances.reduce((sum, acc) => sum + acc.totalKRW, 0);
        
        const currencySummary = accountsWithCalculatedBalances.reduce((summary, account) => {
            Object.entries(account.balances).forEach(([currency, amount]) => {
                summary[currency] = (summary[currency] || 0) + amount;
            });
            return summary;
        }, {});

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
            assetsByCurrency: currencySummary,
        };
    }, [accountsWithCalculatedBalances, cards, transactions]);

    // --- 로그인 및 로그아웃 핸들러 ---
    const handleGoogleSignIn = async () => {
        const provider = new GoogleAuthProvider();
        try {
            await setPersistence(auth, browserLocalPersistence);
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error("Google 로그인 실패:", error);
            alert("로그인에 실패했습니다. 팝업이 차단되었는지 확인해주세요.");
        }
    };

    const handleSignOut = async () => {
        try {
            await signOut(auth);
        } catch (error) {
            console.error("로그아웃 실패:", error);
        }
    };

    // --- 모달 및 뷰 전환 관리 ---
    const handleOpenAddTransactionModal = () => { setEditingTransaction(null); setShowTransactionModal(true); };
    const handleOpenEditTransactionModal = (transaction) => { setEditingTransaction(transaction); setShowTransactionModal(true); };
    const handleOpenAddScheduleModal = (type) => { setEditingSchedule({ type }); setShowScheduleModal(true); };
    const handleOpenEditScheduleModal = (schedule) => { setEditingSchedule(schedule); setShowScheduleModal(true); };
    const handleAccountClick = (accountId) => {
        setTransactionFilter(prev => ({ ...prev, account: accountId, type: 'all', year: 'all', month: 'all', category: 'all', search: '' }));
        setActiveView('transactions');
    };

    // --- 데이터 CRUD 함수 ---
    const handleDeleteTransaction = async (transactionToDelete) => {
        if (!window.confirm(`'${transactionToDelete.description}' 거래를 삭제하시겠습니까?`)) return;
        try {
            await deleteDoc(doc(db, `users/${user.uid}/transactions`, transactionToDelete.id));
            alert('삭제가 완료되었습니다.');
        } catch (error) { console.error("거래 삭제 실패:", error); alert(`삭제 실패: ${error.message}`); }
    };

    const handleDeleteSchedule = async (scheduleId) => {
        if (!window.confirm("이 예정된 항목을 삭제하시겠습니까?")) return;
        try {
            await deleteDoc(doc(db, `users/${user.uid}/schedules`, scheduleId));
            alert("삭제되었습니다.");
        } catch (error) { console.error("스케줄 삭제 실패:", error); alert(`삭제 실패: ${error.message}`);}
    };

    // --- 뷰 렌더링 ---
    const renderView = () => {
        const props = { user, accounts: accountsWithCalculatedBalances, cards, transactions, schedules, currencies, accountsById, cardsById, rates, convertToKRW, categories, memos,
            onAddTransaction: handleOpenAddTransactionModal,
            onEditTransaction: handleOpenEditTransactionModal,
            onDeleteTransaction: handleDeleteTransaction,
            onAddSchedule: handleOpenAddScheduleModal,
            onEditSchedule: handleOpenEditScheduleModal,
            onDeleteSchedule: handleDeleteSchedule,
            onAccountClick: handleAccountClick,
        };
        switch (activeView) {
            case 'dashboard': return <DashboardView {...props} totalAssetInKRW={totalAssetInKRW} totalCashAssetInKRW={totalCashAssetInKRW} upcomingPayments={upcomingPayments} />;
            case 'transactions': return <TransactionsView {...props} filter={transactionFilter} setFilter={setTransactionFilter} />;
            case 'management': return <ManagementView {...props} totalCashAssetInKRW={totalCashAssetInKRW} assetsByCurrency={assetsByCurrency} />;
            case 'schedule': return <ScheduleView {...props} upcomingPayments={upcomingPayments} />;
            case 'currencies': return <CurrencyView {...props} />;
            case 'reports': return <ReportsView {...props} />;
            case 'data': return <DataIOView {...props} />;
            default: return <div>뷰를 찾을 수 없습니다.</div>;
        }
    };
    
    if (isLoading) return <div className="flex justify-center items-center h-screen bg-gray-100"><div className="text-xl font-bold">로딩 중...</div></div>;
    if (!user) return <LoginScreen onGoogleSignIn={handleGoogleSignIn} />;

    return (
        <div className="bg-gray-50 min-h-screen font-sans text-gray-800">
            {isNavOpen && <div onClick={() => setIsNavOpen(false)} className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"></div>}
            <nav className={`fixed inset-y-0 left-0 w-52 bg-white border-r p-4 flex flex-col z-50 transform transition-transform duration-300 ease-in-out md:translate-x-0 ${isNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-2xl font-bold text-indigo-600">가계부</h1>
                    <button onClick={() => setIsNavOpen(false)} className="md:hidden text-gray-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                </div>
                {/* 사용자 정보 표시 */}
                <div className="mb-8 text-center">
                    <img src={user.photoURL || 'https://placehold.co/80x80/e2e8f0/e2e8f0?text=User'} alt="Profile" className="w-20 h-20 rounded-full mx-auto mb-2" />
                    <p className="font-semibold">{user.displayName || '사용자'}</p>
                    <p className="text-xs text-gray-500">{user.email}</p>
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
                 <div className="mt-auto">
                    <button onClick={handleSignOut} className="w-full text-left p-3 rounded-lg flex items-center hover:bg-red-50 text-red-500 transition-colors">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
                        <span className="ml-3 font-semibold">로그아웃</span>
                    </button>
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
                    <TransactionForm user={user} accounts={accounts} cards={cards} onFinish={() => setShowTransactionModal(false)} transactionToEdit={editingTransaction} db={db} currencies={currencies} rates={rates} categories={categories}/>
                </div>
            )}
            {showScheduleModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
                    <ScheduleForm user={user} accounts={accounts} onFinish={() => setShowScheduleModal(false)} scheduleToEdit={editingSchedule} db={db} />
                </div>
            )}
        </div>
    );
}

// --- 뷰 컴포넌트들 ---
function DashboardView({ totalAssetInKRW, totalCashAssetInKRW, upcomingPayments, transactions, accountsById, cardsById, schedules, convertToKRW }) {
    const recentTransactions = transactions.slice(0, 5);
    const upcomingSchedules = useMemo(() => schedules.filter(s => !s.isCompleted).sort((a, b) => a.date.toDate().getTime() - b.date.toDate().getTime()), [schedules]);
    const upcomingIncome = upcomingSchedules.filter(s => s.type === 'income');
    const upcomingExpense = upcomingSchedules.filter(s => s.type === 'expense');

    const totalUpcomingIncome = upcomingIncome.reduce((sum, s) => sum + convertToKRW(s.amount, accountsById[s.accountId]?.currency), 0);
    const totalUpcomingExpense = upcomingExpense.reduce((sum, s) => sum + convertToKRW(s.amount, accountsById[s.accountId]?.currency), 0);

    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">대시보드</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 자산 (예상)</h3><p className="text-3xl font-bold mt-2 text-indigo-600">{formatCurrency(totalAssetInKRW)}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 현금성 자산</h3><p className="text-3xl font-bold mt-2">{formatCurrency(totalCashAssetInKRW)}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 예정 수입</h3><p className="text-3xl font-bold mt-2 text-blue-500">{formatCurrency(totalUpcomingIncome)}</p></div>
                <div className="bg-white p-6 rounded-xl shadow-md"><h3 className="text-gray-500">총 예정 지출</h3><p className="text-3xl font-bold mt-2 text-red-500">{formatCurrency(totalUpcomingExpense + upcomingPayments.reduce((sum, p) => sum + p.amount, 0))}</p></div>
            </div>
            
             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold mb-4">최근 거래 내역</h3>
                    <ul>
                         {recentTransactions.map(t => {
                            const account = accountsById[t.accountId] || {};
                            const currency = t.originalCurrency || account.currency || (t.type === 'card-expense' ? 'KRW' : '');
                            const displayAmount = t.originalAmount || t.amount;
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
                                   {t.type === 'income' ? '+' : '-'} {formatNumber(displayAmount)} {currency !== 'KRW' ? currency : ''}
                                </span>
                            </li>
                         );})}
                         {recentTransactions.length === 0 && <p className="text-gray-500">최근 거래 내역이 없습니다.</p>}
                    </ul>
                 </div>
                 <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold mb-4">다가오는 일정</h3>
                    <h4 className="font-semibold text-blue-600 mt-4 mb-2">예정 수입</h4>
                    {upcomingIncome.length > 0 ? (
                        <ul> {upcomingIncome.slice(0, 3).map(s => <li key={s.id} className="text-sm flex justify-between"><span>{s.description}</span><span>{formatNumber(s.amount)} {accountsById[s.accountId]?.currency}</span></li>)} </ul>
                    ) : <p className="text-sm text-gray-500">예정된 수입이 없습니다.</p>}
                    <h4 className="font-semibold text-red-600 mt-4 mb-2">예정 지출</h4>
                    {upcomingExpense.length > 0 ? (
                        <ul> {upcomingExpense.slice(0, 3).map(s => <li key={s.id} className="text-sm flex justify-between"><span>{s.description}</span><span>{formatNumber(s.amount)} {accountsById[s.accountId]?.currency}</span></li>)} </ul>
                    ) : <p className="text-sm text-gray-500">예정된 지출이 없습니다.</p>}
                 </div>
            </div>
        </div>
    );
}

function TransactionsView({ transactions, accountsById, cardsById, accounts, cards, onAddTransaction, onEditTransaction, onDeleteTransaction, filter, setFilter, categories }) {
    
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
            const categoryMatch = filter.category === 'all' || t.category === filter.category;
            const searchMatch = filter.search === '' || t.description.toLowerCase().includes(filter.search.toLowerCase()) || (t.memo && t.memo.toLowerCase().includes(filter.search.toLowerCase()));

            return typeMatch && accountMatch && dateMatch && categoryMatch && searchMatch;
        });
    }, [transactions, filter]);

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                 <h2 className="text-3xl font-bold">전체 거래 내역</h2>
                 <button onClick={onAddTransaction} className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition">거래 추가</button>
            </div>
            <div className="flex flex-wrap gap-4 mb-4 bg-white p-4 rounded-xl shadow-sm">
                <input type="text" placeholder="내용/메모 검색..." value={filter.search} onChange={e => setFilter({...filter, search: e.target.value})} className="p-2 border rounded-lg bg-white flex-grow"/>
                <select value={filter.type} onChange={e => setFilter({...filter, type: e.target.value})} className="p-2 border rounded-lg bg-white">
                    <option value="all">모든 종류</option><option value="income">수입</option><option value="expense">지출(계좌)</option><option value="card-expense">지출(카드)</option><option value="payment">카드대금</option><option value="transfer">이체</option>
                </select>
                <select value={filter.account} onChange={e => setFilter({...filter, account: e.target.value})} className="p-2 border rounded-lg bg-white">
                    <option value="all">모든 계좌/카드</option>
                    {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                    {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
                </select>
                <select value={filter.category} onChange={e => setFilter({...filter, category: e.target.value})} className="p-2 border rounded-lg bg-white">
                    <option value="all">모든 카테고리</option>
                    {categories.map(cat => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
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
                        const displayCurrency = t.originalCurrency || account.currency || (t.type === 'card-expense' ? 'KRW' : '');
                        const displayAmount = t.originalAmount ?? t.amount;
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
                                        {t.type === 'income' ? '+' : '-'} {formatNumber(displayAmount)} {displayCurrency !== 'KRW' ? displayCurrency : ''}
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

function ManagementView({ user, accounts, cards, transactions, onAddTransaction, currencies, rates, onAccountClick, totalCashAssetInKRW, assetsByCurrency, categories }) {
    const [view, setView] = useState('accounts');
    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-3xl font-bold">계좌/카드 관리</h2>
                <button onClick={onAddTransaction} className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition">거래 추가</button>
            </div>
            
            <div className="bg-white p-6 rounded-xl shadow-md mb-6">
                <h3 className="text-xl font-semibold mb-4">자산 요약</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    {Object.entries(assetsByCurrency).map(([currency, amount]) => (
                        <div key={currency}>
                            <p className="text-gray-500">{currency}</p>
                            <p className="font-bold text-lg">{formatNumber(amount)}</p>
                        </div>
                    ))}
                </div>
                <div className="border-t my-4"></div>
                <div className="flex justify-between items-center">
                    <span className="font-semibold">총 현금성 자산 (KRW 환산)</span>
                    <span className="font-bold text-xl text-indigo-600">{formatCurrency(totalCashAssetInKRW)}</span>
                </div>
            </div>

            <div className="flex border-b mb-4">
                <button onClick={() => setView('accounts')} className={`px-4 py-2 ${view === 'accounts' ? 'border-b-2 border-indigo-500 font-semibold' : 'text-gray-500'}`}>계좌</button>
                <button onClick={() => setView('cards')} className={`px-4 py-2 ${view === 'cards' ? 'border-b-2 border-indigo-500 font-semibold' : 'text-gray-500'}`}>신용카드</button>
                <button onClick={() => setView('categories')} className={`px-4 py-2 ${view === 'categories' ? 'border-b-2 border-indigo-500 font-semibold' : 'text-gray-500'}`}>카테고리</button>
            </div>
            {view === 'accounts' && <AccountList user={user} accounts={accounts} currencies={currencies} rates={rates} db={db} onAccountClick={onAccountClick} />}
            {view === 'cards' && <CardList user={user} cards={cards} accounts={accounts} transactions={transactions} db={db}/>}
            {view === 'categories' && <CategoryView user={user} categories={categories} db={db} />}
        </div>
    );
}

function AccountList({ user, accounts, currencies, rates, db, onAccountClick }) {
    const [editingAccount, setEditingAccount] = useState(null);
    const [filter, setFilter] = useState('all');
    const [sort, setSort] = useState('default');

    const accountCategories = useMemo(() => ['all', ...Array.from(new Set(accounts.map(acc => acc.category)))], [accounts]);

    const displayedAccounts = useMemo(() => {
        let processedAccounts = accounts;
        if (filter !== 'all') {
            processedAccounts = processedAccounts.filter(acc => acc.category === filter);
        }

        switch(sort) {
            case 'name-asc': return [...processedAccounts].sort((a, b) => a.name.localeCompare(b.name));
            case 'name-desc': return [...processedAccounts].sort((a, b) => b.name.localeCompare(a.name));
            case 'balance-asc': return [...processedAccounts].sort((a, b) => a.totalKRW - b.totalKRW);
            case 'balance-desc': return [...processedAccounts].sort((a, b) => b.totalKRW - a.totalKRW);
            case 'category': return [...processedAccounts].sort((a, b) => a.category.localeCompare(b.category));
            default: return processedAccounts;
        }
    }, [accounts, filter, sort]);

    const handleEditClick = (e, account) => {
        e.stopPropagation(); // 부모 클릭 이벤트 방지
        setEditingAccount(account);
    };

    const handleDeleteAccount = async (e, id) => {
        e.stopPropagation();
        if (window.confirm("정말로 계좌를 삭제하시겠습니까? 연결된 모든 거래 내역도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.")) {
            await deleteDoc(doc(db, `users/${user.uid}/accounts`, id));
        }
    }

    return (
        <div className="bg-white p-6 rounded-xl shadow-md">
            {editingAccount ? (
                <AccountForm user={user} accountToEdit={editingAccount} currencies={currencies} onFinish={() => setEditingAccount(null)} db={db} />
            ) : (
                <>
                    <div className="flex flex-wrap gap-4 mb-4">
                        <select value={filter} onChange={e => setFilter(e.target.value)} className="p-2 border rounded-lg bg-white">
                            {accountCategories.map(cat => <option key={cat} value={cat}>{cat === 'all' ? '모든 카테고리' : cat}</option>)}
                        </select>
                        <select value={sort} onChange={e => setSort(e.target.value)} className="p-2 border rounded-lg bg-white">
                            <option value="default">기본 정렬</option>
                            <option value="name-asc">이름순 (ㄱ-ㅎ)</option>
                            <option value="name-desc">이름 역순 (ㅎ-ㄱ)</option>
                            <option value="balance-desc">잔액 많은 순</option>
                            <option value="balance-asc">잔액 적은 순</option>
                            <option value="category">카테고리순</option>
                        </select>
                    </div>
                    {displayedAccounts.map(acc => (
                        <div key={acc.id} onClick={() => onAccountClick(acc.id)} className="flex justify-between items-center p-3 mb-2 border rounded-lg hover:bg-gray-50 cursor-pointer transition-colors">
                            <div className="flex items-center">
                                <span className="text-2xl mr-4">{ICONS[acc.category]}</span>
                                <div>
                                    <p className="font-semibold">{acc.name}</p>
                                    <p className="text-sm text-gray-500">{acc.category}</p>
                                </div>
                            </div>
                            <div className="text-right flex items-center gap-2">
                                <div>
                                    {Object.entries(acc.balances).map(([currency, amount]) => (
                                        <p key={currency} className="text-md font-semibold">{formatNumber(amount)} {currency}</p>
                                    ))}
                                    {Object.keys(acc.balances).length > 1 && <p className="text-sm text-gray-500 font-bold">총 {formatCurrency(acc.totalKRW)}</p>}
                                </div>
                                <button onClick={(e) => handleEditClick(e, acc)} className="p-2 hover:bg-gray-200 rounded-full">✏️</button>
                                <button onClick={(e) => handleDeleteAccount(e, acc.id)} className="p-2 hover:bg-gray-200 rounded-full">🗑️</button>
                            </div>
                        </div>
                    ))}
                    <AccountForm user={user} currencies={currencies} db={db} />
                </>
            )}
        </div>
    );
}

function AccountForm({ user, accountToEdit, currencies, onFinish, db }) {
    const isEditing = !!accountToEdit;
    const [formData, setFormData] = useState({
        name: isEditing ? accountToEdit.name : '',
        category: isEditing ? accountToEdit.category : '은행',
        initialBalance: isEditing ? accountToEdit.initialBalance : '',
        currency: isEditing ? accountToEdit.currency : 'KRW',
    });

    useEffect(() => {
        if(isEditing) {
            setFormData({
                name: accountToEdit.name,
                category: accountToEdit.category,
                initialBalance: accountToEdit.initialBalance,
                currency: accountToEdit.currency,
            })
        }
    }, [accountToEdit, isEditing]);


    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSaveAccount = async (e) => {
        e.preventDefault();
        const dataToSave = {
            ...formData,
            initialBalance: Number(formData.initialBalance),
        };

        if (isEditing) {
            await setDoc(doc(db, `users/${user.uid}/accounts`, accountToEdit.id), dataToSave, { merge: true });
            alert('계좌가 수정되었습니다.');
            onFinish();
        } else {
            await addDoc(collection(db, `users/${user.uid}/accounts`), { ...dataToSave, createdAt: Timestamp.now() });
            setFormData({ name: '', category: '은행', initialBalance: '', currency: 'KRW' }); // Reset form
        }
    };

    return (
        <form onSubmit={handleSaveAccount} className={`p-4 mt-4 ${isEditing ? '' : 'border-t'}`}>
            <h3 className="font-semibold mb-3">{isEditing ? '계좌 수정' : '새 계좌 추가'}</h3>
             <div className="space-y-3">
                <input name="name" value={formData.name} onChange={handleChange} placeholder="계좌 이름" required className="w-full p-2 border rounded"/>
                <div className="grid grid-cols-2 gap-4">
                    <select name="category" value={formData.category} onChange={handleChange} required className="w-full p-2 border rounded">
                        <option value="은행">은행</option><option value="증권">증권</option><option value="코인">코인</option><option value="현금">현금</option><option value="기타">기타</option>
                    </select>
                    <select name="currency" value={formData.currency} onChange={handleChange} required className="w-full p-2 border rounded">
                        {currencies.map(c => <option key={c.symbol} value={c.symbol}>{c.symbol} ({c.name})</option>)}
                    </select>
                </div>
                <input name="initialBalance" type="number" step="any" value={formData.initialBalance} onChange={handleChange} placeholder={isEditing ? '현재 잔액' : '초기 잔액'} required className="w-full p-2 border rounded"/>
                <div className="flex justify-end space-x-2">
                    {isEditing && <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded">취소</button>}
                    <button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">{isEditing ? '수정' : '추가'}</button>
                </div>
            </div>
        </form>
    );
}


function CardList({ user, cards, accounts, transactions, db }) {
    const [editingCard, setEditingCard] = useState(null);

    const handleEditClick = (card) => {
        setEditingCard(card);
    };

    const handleCancelEdit = () => {
        setEditingCard(null);
    };

    const handleDeleteCard = async (id) => {
        if (window.confirm("정말로 신용카드를 삭제하시겠습니까? 연결된 거래 내역은 유지됩니다.")) {
            await deleteDoc(doc(db, `users/${user.uid}/cards`, id));
        }
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
            {editingCard ? (
                <CardForm
                    user={user}
                    cardToEdit={editingCard}
                    accounts={accounts}
                    onFinish={handleCancelEdit}
                    db={db}
                />
            ) : (
                <>
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
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm">결제일: 매월 {card.paymentDay}일</span>
                                        <button onClick={() => handleEditClick(card)} className="p-2 hover:bg-gray-200 rounded-full text-sm">✏️</button>
                                        <button onClick={() => handleDeleteCard(card.id)} className="p-2 hover:bg-gray-200 rounded-full text-sm">🗑️</button>
                                    </div>
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
                    <CardForm user={user} accounts={accounts} db={db} />
                </>
            )}
        </div>
    );
}

function CardForm({ user, cardToEdit, accounts, onFinish, db }) {
    const isEditing = !!cardToEdit;
    const [formData, setFormData] = useState({
        name: isEditing ? cardToEdit.name : '',
        paymentDay: isEditing ? cardToEdit.paymentDay : 15,
        usageStartDay: isEditing ? cardToEdit.usageStartDay : 1,
        usageEndDay: isEditing ? cardToEdit.usageEndDay : 31,
        linkedAccountId: isEditing ? cardToEdit.linkedAccountId : '',
    });

     useEffect(() => {
        if(isEditing) {
            setFormData({
                name: cardToEdit.name,
                paymentDay: cardToEdit.paymentDay,
                usageStartDay: cardToEdit.usageStartDay,
                usageEndDay: cardToEdit.usageEndDay,
                linkedAccountId: cardToEdit.linkedAccountId,
            })
        }
    }, [cardToEdit, isEditing]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSaveCard = async (e) => {
        e.preventDefault();
        const dataToSave = {
            ...formData,
            paymentDay: Number(formData.paymentDay),
            usageStartDay: Number(formData.usageStartDay),
            usageEndDay: Number(formData.usageEndDay),
        };

        if (isEditing) {
            await setDoc(doc(db, `users/${user.uid}/cards`, cardToEdit.id), dataToSave, { merge: true });
            alert('카드가 수정되었습니다.');
            onFinish();
        } else {
            await addDoc(collection(db, `users/${user.uid}/cards`), dataToSave);
            setFormData({ name: '', paymentDay: 15, usageStartDay: 1, usageEndDay: 31, linkedAccountId: '' });
        }
    };
    
    return (
        <form onSubmit={handleSaveCard} className={`p-4 mt-4 ${isEditing ? '' : 'border-t'}`}>
            <h3 className="font-semibold mb-3">{isEditing ? '신용카드 수정' : '새 신용카드 추가'}</h3>
            <div className="space-y-3">
                <div>
                    <label className="text-sm font-medium text-gray-700">카드 이름</label>
                    <input name="name" value={formData.name} onChange={handleChange} className="w-full p-2 border rounded mt-1" required />
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <label className="text-sm font-medium text-gray-700">결제일</label>
                        <input name="paymentDay" type="number" min="1" max="31" value={formData.paymentDay} onChange={handleChange} className="w-full p-2 border rounded mt-1" required />
                    </div>
                    <div>
                        <label className="text-sm font-medium text-gray-700">이용 시작일</label>
                        <input name="usageStartDay" type="number" min="1" max="31" value={formData.usageStartDay} onChange={handleChange} className="w-full p-2 border rounded mt-1" required />
                    </div>
                    <div>
                        <label className="text-sm font-medium text-gray-700">이용 종료일</label>
                        <input name="usageEndDay" type="number" min="1" max="31" value={formData.usageEndDay} onChange={handleChange} className="w-full p-2 border rounded mt-1" required />
                    </div>
                </div>
                <div>
                    <label className="text-sm font-medium text-gray-700">출금 계좌</label>
                    <select name="linkedAccountId" value={formData.linkedAccountId} onChange={handleChange} className="w-full p-2 border rounded mt-1" required>
                        <option value="">출금 계좌 선택</option>
                        {accounts.filter(a => a.currency === 'KRW').map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                    </select>
                </div>
                <div className="flex justify-end space-x-2">
                    {isEditing && <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded">취소</button>}
                    <button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded">{isEditing ? '수정' : '추가'}</button>
                </div>
            </div>
        </form>
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

function ScheduleView({ user, schedules, accounts, upcomingPayments, accountsById, onAddSchedule, onEditSchedule, onDeleteSchedule, memos }) {
    const [newMemo, setNewMemo] = useState("");
    const [editingMemo, setEditingMemo] = useState(null);

    const handleSaveMemo = async () => {
        if (editingMemo) {
            await setDoc(doc(db, `users/${user.uid}/memos`, editingMemo.id), { content: editingMemo.content }, { merge: true });
            setEditingMemo(null);
        } else if (newMemo.trim() !== "") {
            await addDoc(collection(db, `users/${user.uid}/memos`), {
                content: newMemo,
                createdAt: Timestamp.now(),
            });
            setNewMemo("");
        }
    };

    const handleDeleteMemo = async (id) => {
        if (window.confirm("메모를 삭제하시겠습니까?")) {
            await deleteDoc(doc(db, `users/${user.uid}/memos`, id));
        }
    };

    return (
        <div>
            <h2 className="text-3xl font-bold mb-6">스케줄 & 메모</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                    <div className="bg-white p-6 rounded-xl shadow-md">
                        <button onClick={onAddSchedule} className="w-full bg-indigo-500 text-white hover:bg-indigo-600 p-3 rounded-lg">+ 새 예정 수입 추가</button>
                    </div>
                    <div className="bg-white p-6 rounded-xl shadow-md mt-6">
                        <h3 className="text-xl font-semibold mb-4">예정된 수입 목록</h3>
                        <ul className="divide-y divide-gray-200">
                            {schedules.filter(s => !s.isCompleted).map(s => {
                                const account = accountsById[s.accountId] || {};
                                return (
                                <li key={s.id} className="py-3 flex justify-between items-center">
                                    <div>
                                        <p className="font-semibold">{s.description}</p>
                                        <p className="text-sm text-gray-500">{s.date.toDate().toLocaleDateString()} → {account.name}</p>
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        <span className="font-bold text-blue-600">{formatNumber(s.amount)} {account.currency}</span>
                                        <button onClick={() => onEditSchedule(s)} className="p-2 hover:bg-gray-200 rounded-full">✏️</button>
                                        <button onClick={() => onDeleteSchedule(s.id)} className="p-2 hover:bg-gray-200 rounded-full">🗑️</button>
                                    </div>
                                </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-md">
                    <h3 className="text-xl font-semibold mb-4">메모장</h3>
                    <div className="flex gap-2 mb-4">
                        <textarea value={editingMemo ? editingMemo.content : newMemo} 
                                  onChange={(e) => editingMemo ? setEditingMemo({...editingMemo, content: e.target.value}) : setNewMemo(e.target.value)}
                                  className="w-full p-2 border rounded-md" rows="3" placeholder="간단한 메모를 남겨보세요..."></textarea>
                        <button onClick={handleSaveMemo} className="bg-blue-500 text-white px-4 rounded-lg hover:bg-blue-600">{editingMemo ? '수정' : '저장'}</button>
                        {editingMemo && <button onClick={() => setEditingMemo(null)} className="bg-gray-300 px-4 rounded-lg">취소</button>}
                    </div>
                    <ul className="divide-y divide-gray-200">
                        {memos.map(memo => (
                            <li key={memo.id} className="py-2 flex justify-between items-center">
                                <p className="text-gray-700 whitespace-pre-wrap w-full">{memo.content}</p>
                                <div className="flex">
                                    <button onClick={() => setEditingMemo(memo)} className="p-2 hover:bg-gray-200 rounded-full text-sm">✏️</button>
                                    <button onClick={() => handleDeleteMemo(memo.id)} className="p-2 hover:bg-gray-200 rounded-full text-sm">🗑️</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}
function ScheduleForm({ user, accounts, onFinish, scheduleToEdit, db }) {
    const isEditing = !!scheduleToEdit;
    const [formData, setFormData] = useState({
        description: isEditing ? scheduleToEdit.description : '',
        amount: isEditing ? scheduleToEdit.amount : '',
        date: isEditing ? new Date(scheduleToEdit.date.toDate()).toISOString().slice(0, 16) : '',
        accountId: isEditing ? scheduleToEdit.accountId : '',
    });

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({...prev, [name]: value}));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const dataToSave = {
            ...formData,
            amount: Number(formData.amount),
            date: Timestamp.fromDate(new Date(formData.date)),
        };

        try {
            if (isEditing) {
                const scheduleRef = doc(db, `users/${user.uid}/schedules`, scheduleToEdit.id);
                await setDoc(scheduleRef, dataToSave, { merge: true });
                alert("수정되었습니다.");
            } else {
                await addDoc(collection(db, `users/${user.uid}/schedules`), {
                    ...dataToSave,
                    isCompleted: false,
                    createdAt: Timestamp.now(),
                });
                alert("등록되었습니다.");
            }
            onFinish();
        } catch (error) {
            console.error("스케줄 저장 실패:", error);
            alert(`저장 실패: ${error.message}`);
        }
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-lg max-w-lg mx-auto w-full">
            <h2 className="text-2xl font-bold mb-4">{isEditing ? '예정 수입 수정' : '예정 수입 등록'}</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
                <input name="date" type="datetime-local" value={formData.date} onChange={handleChange} className="w-full p-2 border rounded" required />
                <input name="description" value={formData.description} onChange={handleChange} placeholder="내용 (예: 이벤트 당첨금)" className="w-full p-2 border rounded" required />
                <input name="amount" type="number" step="any" value={formData.amount} onChange={handleChange} placeholder="금액" className="w-full p-2 border rounded" required />
                <select name="accountId" value={formData.accountId} onChange={handleChange} className="w-full p-2 border rounded" required>
                    <option value="">입금될 계좌</option>
                    {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name} ({acc.currency})</option>)}
                </select>
                <div className="flex justify-end space-x-2 pt-4">
                    <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded-lg">취소</button>
                    <button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded-lg">저장</button>
                </div>
            </form>
        </div>
    );
}


function TransactionForm({ user, accounts, cards, onFinish, transactionToEdit, db, currencies, rates, categories }) {
    const isEditing = !!transactionToEdit;
    
    const [type, setType] = useState(isEditing ? transactionToEdit.type : 'expense');
    const [formData, setFormData] = useState({
        date: isEditing ? new Date(transactionToEdit.date.toDate()).toISOString().slice(0,16) : new Date().toISOString().slice(0, 16),
        description: isEditing ? transactionToEdit.description : '',
        inputAmount: isEditing ? transactionToEdit.originalAmount ?? transactionToEdit.amount : '',
        category: isEditing ? transactionToEdit.category || '' : '',
        memo: isEditing ? transactionToEdit.memo || '' : '',
        accountId: isEditing ? transactionToEdit.accountId : '',
        cardId: isEditing ? transactionToEdit.cardId : '',
        fromAccountId: isEditing && transactionToEdit.type === 'transfer' ? transactionToEdit.accountId : '',
        toAccountId: isEditing ? transactionToEdit.toAccountId : '',
    });
    const [inputCurrency, setInputCurrency] = useState('KRW');

    useEffect(() => {
        if (isEditing) {
            setInputCurrency(transactionToEdit.originalCurrency || accounts.find(a => a.id === transactionToEdit.accountId)?.currency || 'KRW');
        } else {
            const accountId = type === 'transfer' ? formData.fromAccountId : formData.accountId;
            const account = accounts.find(a => a.id === accountId);
            if (account) {
                setInputCurrency(account.currency);
            }
        }
    }, [formData.accountId, formData.fromAccountId, type, accounts, isEditing, transactionToEdit]);


    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const convertedAmount = useMemo(() => {
        const accountId = type === 'transfer' ? formData.fromAccountId : formData.accountId;
        const account = accounts.find(a => a.id === accountId);
        if (!account || !formData.inputAmount || !rates[inputCurrency] || !rates[account.currency]) {
            return null;
        }
        if (inputCurrency === account.currency) return null;

        const amountInKRW = formData.inputAmount * rates[inputCurrency];
        return amountInKRW / rates[account.currency];

    }, [formData.inputAmount, inputCurrency, formData.accountId, formData.fromAccountId, type, accounts, rates]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        try {
            const dataForSubmit = {
                description: formData.description,
                originalAmount: Number(formData.inputAmount),
                originalCurrency: inputCurrency,
                memo: formData.memo,
                date: Timestamp.fromDate(new Date(formData.date)),
                category: formData.category || '',
                type,
                accountId: type === 'transfer' ? formData.fromAccountId : formData.accountId,
                toAccountId: type === 'transfer' ? formData.toAccountId : null,
                cardId: type === 'card-expense' ? formData.cardId : null,
                isPaid: type === 'card-expense' ? (isEditing ? transactionToEdit.isPaid : false) : null,
            };

            if (isEditing) {
                const transRef = doc(db, `users/${user.uid}/transactions`, transactionToEdit.id);
                await setDoc(transRef, dataForSubmit, { merge: true });
                alert('수정이 완료되었습니다.');
            } else {
                const newTransactionRef = doc(collection(db, `users/${user.uid}/transactions`));
                await setDoc(newTransactionRef, dataForSubmit);
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
                 <div className="flex gap-2">
                    <input name="inputAmount" type="number" step="any" placeholder="금액" value={formData.inputAmount} onChange={handleChange} required className="w-2/3 p-2 border rounded-md"/>
                    <select value={inputCurrency} onChange={e => setInputCurrency(e.target.value)} className="w-1/3 p-2 border rounded-md" disabled={type==='card-expense'}>
                        {currencies.map(c => <option key={c.symbol} value={c.symbol}>{c.symbol}</option>)}
                    </select>
                 </div>
                 {convertedAmount && <p className="text-sm text-gray-500 text-center">≈ {formatNumber(convertedAmount)} {accounts.find(a=>a.id === (type === 'transfer' ? formData.fromAccountId : formData.accountId))?.currency}</p>}
                 
                {(type === 'expense' || type === 'income') && (
                    <>
                        <select name="accountId" required className="w-full p-2 border rounded-md" value={formData.accountId} onChange={handleChange}>
                           <option value="">{type === 'expense' ? '출금' : '입금'} 계좌 선택</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                        </select>
                        <select name="category" value={formData.category} onChange={handleChange} className="w-full p-2 border rounded-md">
                            <option value="">카테고리 선택</option>
                            {categories.map(cat => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
                        </select>
                    </>
                )}
                 {type === 'card-expense' && (
                    <>
                        <select name="cardId" required className="w-full p-2 border rounded-md" value={formData.cardId} onChange={handleChange}>
                            <option value="">사용 카드 선택</option>
                            {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
                        </select>
                         <select name="category" value={formData.category} onChange={handleChange} className="w-full p-2 border rounded-md">
                            <option value="">카테고리 선택</option>
                            {categories.map(cat => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
                        </select>
                    </>
                 )}
                 {type === 'transfer' && (
                    <>
                       <select name="fromAccountId" required className="w-full p-2 border rounded-md" value={formData.fromAccountId} onChange={handleChange}>
                            <option value="">보내는 계좌</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                        </select>
                        <select name="toAccountId" required className="w-full p-2 border rounded-md" value={formData.toAccountId} onChange={handleChange}>
                            <option value="">받는 계좌</option>
                            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                        </select>
                    </>
                )}
                <textarea name="memo" value={formData.memo} onChange={handleChange} placeholder="메모 (선택)" className="w-full p-2 border rounded-md" rows="2"></textarea>
                <div className="flex justify-end space-x-2 pt-4">
                    <button type="button" onClick={onFinish} className="bg-gray-200 px-4 py-2 rounded-lg">취소</button>
                    <button type="submit" className="bg-indigo-500 text-white px-4 py-2 rounded-lg">저장</button>
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
function CategoryView({ user, categories, db }) {
    const [editingCategory, setEditingCategory] = useState(null);

    const handleSaveCategory = async (e) => {
        e.preventDefault();
        const name = e.target.elements.name.value;
        if (!name) return;

        if (editingCategory) {
            await setDoc(doc(db, `users/${user.uid}/categories`, editingCategory.id), { name }, { merge: true });
            setEditingCategory(null);
        } else {
            await addDoc(collection(db, `users/${user.uid}/categories`), { name });
            e.target.elements.name.value = "";
        }
    };

    const handleDeleteCategory = async (id) => {
        if (window.confirm("카테고리를 삭제하시겠습니까?")) {
            await deleteDoc(doc(db, `users/${user.uid}/categories`, id));
        }
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-md">
            <h3 className="text-xl font-semibold mb-4">거래 카테고리 관리</h3>
            <form onSubmit={handleSaveCategory} className="flex gap-2 mb-4">
                <input name="name" defaultValue={editingCategory?.name || ""} placeholder="새 카테고리 이름" className="w-full p-2 border rounded-md" required />
                <button type="submit" className="bg-indigo-500 text-white px-4 rounded-lg hover:bg-indigo-600">{editingCategory ? '수정' : '추가'}</button>
                {editingCategory && <button type="button" onClick={() => setEditingCategory(null)} className="bg-gray-300 px-4 rounded-lg">취소</button>}
            </form>
            <ul className="divide-y divide-gray-200">
                {categories.map(cat => (
                    <li key={cat.id} className="py-2 flex justify-between items-center">
                        <span>{cat.name}</span>
                        <div className="flex gap-2">
                            <button onClick={() => setEditingCategory(cat)} className="p-2 hover:bg-gray-200 rounded-full text-sm">✏️</button>
                            <button onClick={() => handleDeleteCategory(cat.id)} className="p-2 hover:bg-gray-200 rounded-full text-sm">🗑️</button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}