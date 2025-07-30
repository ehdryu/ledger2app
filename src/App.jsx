import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, addDoc, getDocs, writeBatch, query, onSnapshot, setDoc, deleteDoc, Timestamp, runTransaction } from 'firebase/firestore';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, signInAnonymously, linkWithCredential, browserLocalPersistence, setPersistence } from 'firebase/auth';
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
    const [transactionFilter, setTransactionFilter] = useState({ type: 'all', account: 'all', year: 'all', month: 'all' });
    
    const [accounts, setAccounts] = useState([]);
    const [cards, setCards] = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [schedules, setSchedules] = useState([]);
    const [currencies, setCurrencies] = useState([]);

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

    const { totalAssetInKRW, totalCashAssetInKRW, upcomingPayments, assetsByCurrency } = useMemo(() => {
        const totalCash = accounts.reduce((sum, acc) => sum + convertToKRW(acc.balance || 0, acc.currency), 0);
        
        const currencySummary = accounts.reduce((summary, account) => {
            const { currency, balance } = account;
            if (!summary[currency]) {
                summary[currency] = 0;
            }
            summary[currency] += balance;
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
    }, [accounts, cards, transactions, convertToKRW]);

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
    const handleOpenAddScheduleModal = () => { setEditingSchedule(null); setShowScheduleModal(true); };
    const handleOpenEditScheduleModal = (schedule) => { setEditingSchedule(schedule); setShowScheduleModal(true); };
    const handleAccountClick = (accountId) => {
        setTransactionFilter(prev => ({ ...prev, account: accountId }));
        setActiveView('transactions');
    };

    // --- 데이터 CRUD 함수 ---
    const handleDeleteTransaction = async (transactionToDelete) => {
        // ... (이전 코드와 동일)
    };

    const handleDeleteSchedule = async (scheduleId) => {
        // ... (이전 코드와 동일)
    };

    // --- 뷰 렌더링 ---
    const renderView = () => {
        const props = { user, accounts, cards, transactions, schedules, currencies, accountsById, cardsById, rates, convertToKRW,
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
                    <TransactionForm user={user} accounts={accounts} cards={cards} onFinish={() => setShowTransactionModal(false)} transactionToEdit={editingTransaction} db={db} currencies={currencies} rates={rates}/>
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
    // ... (이전 코드와 동일)
}

function TransactionsView({ transactions, accountsById, cardsById, accounts, cards, onAddTransaction, onEditTransaction, onDeleteTransaction, filter, setFilter }) {
    // ... (이전 코드와 동일, 내부 상태 대신 props 사용)
}

function ManagementView({ user, accounts, cards, transactions, onAddTransaction, currencies, rates, onAccountClick, totalCashAssetInKRW, assetsByCurrency }) {
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
            </div>
            {view === 'accounts' && <AccountList user={user} accounts={accounts} currencies={currencies} rates={rates} db={db} onAccountClick={onAccountClick} />}
            {view === 'cards' && <CardList user={user} cards={cards} accounts={accounts} transactions={transactions} db={db}/>}
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
            case 'balance-asc': return [...processedAccounts].sort((a, b) => (a.balance * (rates[a.currency] || 1)) - (b.balance * (rates[b.currency] || 1)));
            case 'balance-desc': return [...processedAccounts].sort((a, b) => (b.balance * (rates[b.currency] || 1)) - (a.balance * (rates[a.currency] || 1)));
            case 'category': return [...processedAccounts].sort((a, b) => a.category.localeCompare(b.category));
            default: return processedAccounts;
        }
    }, [accounts, filter, sort, rates]);

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
                                    <p className="text-sm text-gray-500">{acc.category} ({acc.currency})</p>
                                </div>
                            </div>
                            <div className="text-right flex items-center gap-2">
                                <div>
                                    <p className="text-lg font-bold">{formatNumber(acc.balance)} {acc.currency}</p>
                                    {acc.currency !== 'KRW' && <p className="text-sm text-gray-500">{formatCurrency(acc.balance * (rates[acc.currency] || 1))}</p>}
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

// ... AccountForm, CardList, CardForm, CurrencyView, ScheduleView, ScheduleForm, TransactionForm, ReportsView, DataIOView ...
// --- 여기에 나머지 모든 컴포넌트 함수 정의가 와야 합니다 ---
// (이전 버전과 동일한 내용이므로 생략)
