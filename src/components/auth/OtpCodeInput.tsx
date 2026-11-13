import { useId, useRef, useState } from 'react';

interface OtpCodeInputProps {
  value: string;
  onChange: (nextValue: string) => void;
  length: number;
  disabled?: boolean;
  hasError?: boolean;
}

export function OtpCodeInput({
  value,
  onChange,
  length,
  disabled = false,
  hasError = false,
}: OtpCodeInputProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  const sanitized = value.replace(/\D/g, '').slice(0, length);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, length);
    onChange(digitsOnly);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;
    event.preventDefault();
    const digitsOnly = pasted.replace(/\D/g, '').slice(0, length);
    onChange(digitsOnly);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && sanitized.length > 0) {
      // Allow native input backspace to delete cleanly
      return;
    }
  };

  return (
    <div>
      <label
        htmlFor={inputId}
        className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
      >
        Verification Code ({length} digits)
      </label>

      <div
        className="relative mt-2.5"
        onClick={() => inputRef.current?.focus()}
      >
        {/* Single semantic input for reliable SMS one-time-code autofill, paste, and screen readers */}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={length}
          value={sanitized}
          disabled={disabled}
          onChange={handleChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onFocus={(e) => {
            setIsFocused(true);
            e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
          onBlur={() => setIsFocused(false)}
          aria-invalid={hasError}
          className="peer absolute inset-0 z-10 h-full w-full cursor-text opacity-0 text-base"
        />

        <div
          aria-hidden="true"
          className="grid gap-2 sm:gap-2.5"
          style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}
        >
          {Array.from({ length }).map((_, idx) => {
            const char = sanitized[idx] ?? '';
            const isActiveSlot =
              isFocused && (idx === sanitized.length || (sanitized.length === length && idx === length - 1));

            return (
              <div
                key={idx}
                className={`flex h-12 sm:h-13 items-center justify-center rounded-xl border text-lg font-semibold tabular-nums transition-all duration-150 ${
                  disabled
                    ? 'border-[#49243E]/10 bg-[#49243E]/[0.04] text-[#242124]/45'
                    : hasError
                      ? 'border-[#B8334A]/60 bg-[#FFF5F7] text-[#49243E]'
                      : isActiveSlot
                        ? 'border-[#B76E79] bg-white text-[#49243E] ring-2 ring-[#B76E79]/35'
                        : char
                          ? 'border-[#49243E]/35 bg-[#FFF9F5] text-[#49243E]'
                          : 'border-[#49243E]/18 bg-[#FFF9F5]/80 text-[#49243E]'
                }`}
              >
                {char || (isActiveSlot ? <span className="h-5 w-[1.5px] bg-[#B76E79]" /> : '')}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
