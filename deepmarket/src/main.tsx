import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { registerSlushWallet } from '@mysten/slush-wallet';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import App from './App';
import { MessagingClientProvider } from './contexts/MessagingClientContext';
import '@mysten/dapp-kit/dist/index.css';
import './index.css';

// Register the Slush WEB wallet with Wallet Standard so it shows up in the
// connect modal — users without the Slush extension can onboard via the web
// app (no install). Must run once, as early as possible.
// https://sdk.mystenlabs.com/slush-wallet/dapp
//
// MOBILE: skip registration. The Slush web flow requires a child window opened
// via window.open() with a working `window.opener` back-channel; mobile
// browsers strip window.opener when popups land as a new tab, producing
// "This functionality requires a window opened through window.open …"
// Mobile users get the Slush mobile app / other wallet-standard wallets instead.
const isMobile =
    typeof navigator !== 'undefined' &&
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (!isMobile) {
    registerSlushWallet('DeepMarket');
}

const queryClient = new QueryClient();

const testnetClient = new SuiJsonRpcClient({
  url: 'https://fullnode.testnet.sui.io:443',
  network: 'testnet',
});

const networks = {
  testnet: testnetClient,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networks} defaultNetwork="testnet">
        <WalletProvider autoConnect>
          <MessagingClientProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </MessagingClientProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
