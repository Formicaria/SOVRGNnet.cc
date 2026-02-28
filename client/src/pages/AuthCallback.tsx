import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { Loader2 } from 'lucide-react';

export default function AuthCallback() {
  const [, setLocation] = useLocation();
  const { user, loading } = useSupabaseAuth();

  useEffect(() => {
    // If user is authenticated, redirect to dashboard
    if (!loading && user) {
      setLocation('/dashboard');
    }
  }, [user, loading, setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="text-center space-y-4">
        <Loader2 className="animate-spin w-8 h-8 text-purple-500 mx-auto" />
        <p className="text-slate-300">Completing sign in...</p>
      </div>
    </div>
  );
}
