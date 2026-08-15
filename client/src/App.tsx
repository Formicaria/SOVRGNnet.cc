import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Web3Provider } from "./contexts/Web3Context";
import { MatrixProvider } from "./contexts/MatrixContext";
import { IPFSProvider } from "./contexts/IPFSContext";
import { AuthProvider } from "./contexts/AuthContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Invite from "./pages/Invite";
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
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <WagmiProvider config={config}>
          <RainbowKitProvider>
            <Web3Provider>
              <MatrixProvider>
                <IPFSProvider>
                  <ThemeProvider defaultTheme="dark">
                    <TooltipProvider>
                      <Toaster />
                      <Router />
                    </TooltipProvider>
                  </ThemeProvider>
                </IPFSProvider>
              </MatrixProvider>
            </Web3Provider>
          </RainbowKitProvider>
        </WagmiProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
