import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";

/**
 * The signed-in account — taken from what `auth.me` actually returns.
 *
 * Inferred rather than declared. This was a hand-written mirror of the server
 * shape, and it drifted the moment #29 added `username`: the field the entire
 * identity model now turns on was invisible to every component, while the type
 * still advertised `openId`, which no client code has ever read. Nothing broke
 * loudly — the mirror was internally consistent, it was just describing an
 * older server. Inferring it makes the compiler report that at the call site.
 */
type AuthUser = inferRouterOutputs<AppRouter>["auth"]["me"];

interface AuthContextType {
  user: AuthUser;
  loading: boolean;
  /** `identifier` is a username or an email address; the caller needn't know. */
  login: (identifier: string, password: string) => Promise<void>;
  register: (
    username: string,
    password: string,
    /** Optional: an account is its username, not its email address. */
    email?: string,
    name?: string,
    inviteCode?: string,
    /** Only the first account on an instance needs this. */
    setupToken?: string
  ) => Promise<void>;
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

  /**
   * Sign in with whichever the person typed.
   *
   * One field on the form, two on the wire: an entry containing `@` is sent as
   * an email and anything else as a username. The server accepts either and
   * gives the same answer when it fails, so guessing wrong here costs a failed
   * attempt and nothing else. `@` is a safe discriminator because usernames
   * cannot contain one.
   */
  const login = async (identifier: string, password: string) => {
    const trimmed = identifier.trim();
    const user = await loginMutation.mutateAsync(
      trimmed.includes("@")
        ? { email: trimmed, password }
        : { username: trimmed, password }
    );
    utils.auth.me.setData(undefined, user);
  };

  const register = async (
    username: string,
    password: string,
    email?: string,
    name?: string,
    inviteCode?: string,
    setupToken?: string
  ) => {
    // An invite-only instance needs the code at registration, not just at the
    // point of joining a server. A code typed into the form wins; otherwise
    // the one an invite link stashed before sending the visitor to sign up.
    const code =
      inviteCode?.trim() ||
      sessionStorage.getItem("pending_invite") ||
      undefined;

    const user = await registerMutation.mutateAsync({
      username: username.trim(),
      password,
      // Omitted rather than sent empty: the column is nullable and "" would
      // be stored as an address nobody has, which the unique index then
      // treats as a collision for the second person who skips it.
      email: email?.trim() || undefined,
      name,
      inviteCode: code,
      // Only the very first account is asked for this, and the server ignores
      // it afterwards. Sent as undefined rather than "" so an empty field
      // doesn't read as an attempt.
      setupToken: setupToken?.trim() || undefined,
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
