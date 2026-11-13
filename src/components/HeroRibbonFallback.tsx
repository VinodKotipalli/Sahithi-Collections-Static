export function HeroRibbonFallback({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none flex items-center justify-center select-none ${className}`}
    >
      <svg
        viewBox="0 0 420 420"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-full max-w-[360px] opacity-90"
      >
        <defs>
          <linearGradient id="ribbonRoseGold" x1="40" y1="40" x2="380" y2="380" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#F3D5DF" stopOpacity="0.88" />
            <stop offset="48%" stopColor="#D79CA6" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#49243E" stopOpacity="0.28" />
          </linearGradient>
          <linearGradient id="ribbonPearl" x1="120" y1="60" x2="300" y2="360" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFF9F5" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#F3D5DF" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#B76E79" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <circle cx="210" cy="210" r="142" stroke="#B76E79" strokeOpacity="0.28" strokeWidth="1.2" />
        <ellipse
          cx="210"
          cy="210"
          rx="158"
          ry="74"
          transform="rotate(-28 210 210)"
          stroke="url(#ribbonRoseGold)"
          strokeWidth="16"
          strokeLinecap="round"
        />
        <ellipse
          cx="210"
          cy="210"
          rx="148"
          ry="64"
          transform="rotate(32 210 210)"
          stroke="url(#ribbonPearl)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <circle cx="118" cy="134" r="9" fill="#FFF9F5" stroke="#B76E79" strokeOpacity="0.45" strokeWidth="1.5" />
        <circle cx="318" cy="272" r="11" fill="#F3D5DF" stroke="#B76E79" strokeOpacity="0.4" strokeWidth="1.5" />
        <circle cx="268" cy="108" r="6" fill="#FFF9F5" stroke="#B76E79" strokeOpacity="0.35" strokeWidth="1.2" />
      </svg>
    </div>
  );
}
