import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
    id: number;
    type: ToastType;
    title: string;
    message?: string;
}

interface ToastContextValue {
    toast: (type: ToastType, title: string, message?: string) => void;
}

const ToastCtx = createContext<ToastContextValue>({ toast: () => { } });

let id = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const toast = useCallback((type: ToastType, title: string, message?: string) => {
        const entry: Toast = { id: ++id, type, title, message };
        setToasts(prev => [...prev, entry]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== entry.id)), 5000);
    }, []);

    const getIcon = (type: ToastType) => {
        if (type === 'success') return <CheckCircle2 size={20} className="toast-icon" />;
        if (type === 'error') return <XCircle size={20} className="toast-icon" />;
        return <Info size={20} className="toast-icon" />;
    };

    return (
        <ToastCtx.Provider value={{ toast }}>
            {children}
            <div className="toast-container">
                {toasts.map(t => (
                    <div
                        key={t.id}
                        className={`toast toast-${t.type}`}
                        onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                    >
                        {getIcon(t.type)}
                        <div className="toast-content">
                            <div className="toast-title">{t.title}</div>
                            {t.message && <div className="toast-desc">{t.message}</div>}
                        </div>
                    </div>
                ))}
            </div>
        </ToastCtx.Provider>
    );
}

export function useToast() {
    return useContext(ToastCtx);
}
