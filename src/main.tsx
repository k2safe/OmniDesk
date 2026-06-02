import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { QuickPanel } from './components/QuickPanel.tsx';
import './index.css';

const params = new URLSearchParams(window.location.search);
const isQuickPanel = params.get("quick") === "1";
const Root = isQuickPanel ? QuickPanel : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
