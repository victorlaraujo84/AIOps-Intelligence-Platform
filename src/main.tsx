import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const PostgresConsole = lazy(() => import('./components/PostgresConsole.tsx'));
const postgresRoute = /^\/postgres-inventory\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  postgresRoute ? <Suspense fallback={null}><PostgresConsole /></Suspense> : <App />,
);
