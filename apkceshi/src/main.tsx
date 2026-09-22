import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MobileVmFrame } from './MobileVmFrame';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileVmFrame>
      <App />
    </MobileVmFrame>
  </StrictMode>,
);
