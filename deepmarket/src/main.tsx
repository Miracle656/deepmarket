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
// app (no install). Must run once, as early as possible. Extension users still
// see the extension. https://sdk.mystenlabs.com/slush-wallet/dapp
registerSlushWallet('DeepMarket');

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
