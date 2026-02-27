export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Supabase Auth login - redirects to Supabase OAuth
export const getLoginUrl = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const redirectUri = window.location.origin;
  
  // Construct Supabase OAuth URL
  const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", "google"); // or github
  url.searchParams.set("redirect_to", redirectUri);
  url.searchParams.set("scopes", "openid profile email");
  
  return url.toString();
};

// Get GitHub login URL
export const getGitHubLoginUrl = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const redirectUri = window.location.origin;
  
  const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", "github");
  url.searchParams.set("redirect_to", redirectUri);
  url.searchParams.set("scopes", "user:email");
  
  return url.toString();
};
