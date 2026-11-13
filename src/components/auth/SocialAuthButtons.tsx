import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

interface SocialAuthButtonsProps {
  isGoogleConfigured: boolean;
  isAppleConfigured: boolean;
  isSubmittingProvider: 'google' | 'apple' | null;
  disabled?: boolean;
  onSelectProvider: (provider: 'google' | 'apple') => void;
}

function GoogleIcon() {
  return (
    <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-8.97Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg className="h-[18px] w-[18px] shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43Zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45Z" />
    </svg>
  );
}

export function SocialAuthButtons({
  isGoogleConfigured,
  isAppleConfigured,
  isSubmittingProvider,
  disabled = false,
  onSelectProvider,
}: SocialAuthButtonsProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const anyUnconfigured = !isGoogleConfigured || !isAppleConfigured;

  return (
    <div>
      <div className="relative my-6 flex items-center">
        <div className="flex-grow border-t border-[#49243E]/12" />
        <span className="mx-3 shrink-0 text-xs font-medium text-[#242124]/55">
          or login with
        </span>
        <div className="flex-grow border-t border-[#49243E]/12" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <motion.button
          type="button"
          disabled={disabled || !isGoogleConfigured || isSubmittingProvider !== null}
          onClick={() => onSelectProvider('google')}
          whileHover={
            !prefersReducedMotion && isGoogleConfigured && !disabled ? { y: -1 } : undefined
          }
          whileTap={
            !prefersReducedMotion && isGoogleConfigured && !disabled ? { scale: 0.98 } : undefined
          }
          className={`flex min-h-[46px] w-full items-center justify-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors duration-200 whitespace-nowrap ${
            isGoogleConfigured && !disabled
              ? 'border-[#49243E]/18 bg-white text-[#242124] hover:border-[#49243E]/40 hover:bg-[#FFF9F5]'
              : 'cursor-not-allowed border-[#49243E]/10 bg-[#49243E]/[0.03] text-[#242124]/45'
          }`}
        >
          {isSubmittingProvider === 'google' ? (
            <Loader2 className="h-4 w-4 animate-spin text-[#49243E]" aria-hidden="true" />
          ) : (
            <GoogleIcon />
          )}
          <span>Google</span>
        </motion.button>

        <motion.button
          type="button"
          disabled={disabled || !isAppleConfigured || isSubmittingProvider !== null}
          onClick={() => onSelectProvider('apple')}
          whileHover={
            !prefersReducedMotion && isAppleConfigured && !disabled ? { y: -1 } : undefined
          }
          whileTap={
            !prefersReducedMotion && isAppleConfigured && !disabled ? { scale: 0.98 } : undefined
          }
          className={`flex min-h-[46px] w-full items-center justify-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors duration-200 whitespace-nowrap ${
            isAppleConfigured && !disabled
              ? 'border-[#49243E]/18 bg-white text-[#242124] hover:border-[#49243E]/40 hover:bg-[#FFF9F5]'
              : 'cursor-not-allowed border-[#49243E]/10 bg-[#49243E]/[0.03] text-[#242124]/45'
          }`}
        >
          {isSubmittingProvider === 'apple' ? (
            <Loader2 className="h-4 w-4 animate-spin text-[#49243E]" aria-hidden="true" />
          ) : (
            <AppleIcon />
          )}
          <span>Apple</span>
        </motion.button>
      </div>

      {anyUnconfigured && (
        <p className="mt-2.5 text-center text-[11px] leading-relaxed text-[#242124]/60">
          {!isGoogleConfigured && !isAppleConfigured
            ? 'Google & Apple sign-in are disabled until OAuth providers are enabled in Supabase and .env.'
            : !isGoogleConfigured
              ? 'Google sign-in requires VITE_AUTH_ENABLE_GOOGLE="true" and OAuth setup.'
              : 'Apple sign-in requires VITE_AUTH_ENABLE_APPLE="true" and OAuth setup.'}
        </p>
      )}
    </div>
  );
}
