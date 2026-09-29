import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@wanteddev/wds';
import '@wanteddev/wds/global.css';

import App from './App.jsx';

createRoot(document.getElementById('app')).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
