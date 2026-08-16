import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";

type AuthUser = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  role: "user" | "admin";
} | null;

interface AuthContextType {
  user: AuthUser;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = trpc.auth.login.useMutation();
  const registerMutation = trpc.auth.register.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();

  const login = async (email: string, password: string) => {
    const user = await loginMutation.mutateAsync({ email, password });
    utils.auth.me.setData(undefined, user);
  };

  const register = async (email: string, password: string, name?: string) => {
    // An invite-only instance needs the code at registration, not just at the
    // point of joining a server. The invite page stashes it here before
    // sending an unauthenticated visitor off to sign up.
    const inviteCode = sessionStorage.getItem("pending_invite") ?? undefined;

    const user = await registerMutation.mutateAsync({
      email,
      password,
      name,
      inviteCode,
    });
    utils.auth.me.setData(undefined, user);
  };

  const logout = async () => {
    await logoutMutation.mutateAsync();
    utils.auth.me.setData(undefined, null);
    await utils.invalidate();
  };

  return (
    <AuthContext.Provider
      value={{
        user: (meQuery.data as AuthUser) ?? null,
        loading: meQuery.isLoading,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
