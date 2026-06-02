export function OmniDeskLogo({ size = 64 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="OmniDesk"
      className="drop-shadow-[0_16px_32px_rgba(5,150,105,0.18)]"
    >
      <defs>
        <linearGradient id="omnidesk-logo-bg" x1="96" y1="64" x2="416" y2="448" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f8fafc" />
          <stop offset="1" stopColor="#eef7f4" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="384" height="384" rx="92" fill="url(#omnidesk-logo-bg)" />
      <path d="M64 252c58-30 46-118 94-166h58L64 342z" fill="#a7f3d0" opacity="0.48" />
      <path d="M230 64h72l82 384h-72z" fill="#99f6e4" opacity="0.46" />
      <path d="M448 240c-58 32-42 119-93 160h-58l151-252z" fill="#a7f3d0" opacity="0.52" />
      <rect x="64" y="64" width="384" height="384" rx="92" fill="none" stroke="#cbd5e1" strokeWidth="8" />
      <g transform="translate(126 126) scale(10.833333)">
        <path
          d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0 0-6"
          fill="none"
          stroke="#059669"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
