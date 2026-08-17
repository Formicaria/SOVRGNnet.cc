import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Web3Provider } from "./contexts/Web3Context";
import { MatrixProvider } from "./contexts/MatrixContext";
import { AuthProvider } from "./contexts/AuthContext";
import { ConnectionsProvider } from "./contexts/ConnectionsContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Invite from "./pages/Invite";
import SsoCallback from "./pages/SsoCallback";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { config } from "./lib/wagmi";
import "@rainbow-me/rainbowkit/styles.css";

// tRPC + React Query providers live in main.tsx and wrap this component.

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/invite/:code" component={Invite} />
      <Route path="/sso/callback" component={SsoCallback} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        {/* Which servers this client knows about. Outside the per-server
            providers below, because it outlives any one connection. */}
        <ConnectionsProvider>
        <WagmiProvider config={config}>
          <RainbowKitProvider>
            <Web3Provider>
              <MatrixProvider>
                {/* No IPFSProvider. It used to sit here, and deleting it was
                    a security fix as much as a cleanup: nothing ever called
                    useIPFS, but the code it carried would have POSTed
                    *plaintext* file bytes straight to Kubo's unauthenticated
                    API on :5001 over plain HTTP, bypassing both the
                    client-side encryption from #17 and /api/upload. It also
                    defaulted to a third-party public gateway
                    (gateway.pinata.cloud), which is the exact opposite of what
                    this project claims. Uploads go through lib/attachments.ts.
                    Removing it also dropped axios, and with it 28 of the 43
                    advisories `pnpm audit --prod` was reporting. */}
                <ThemeProvider defaultTheme="dark">
                  <TooltipProvider>
                    <Toaster />
                    <Router />
                  </TooltipProvider>
                </ThemeProvider>
              </MatrixProvider>
            </Web3Provider>
          </RainbowKitProvider>
        </WagmiProvider>
        </ConnectionsProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
