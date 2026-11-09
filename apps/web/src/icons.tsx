/** Icons: 2.25 px stroke, sharp corners (brand sheet). The first eight paths come from the design file. */
const PATHS = {
  activity: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  chat: 'M4 5h16v11H10l-6 4z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  diamond: 'M12 3l9 9-9 9-9-9zM12 9l3 3-3 3-3-3z',
  doc: 'M6 3h9l4 4v14H6zM9 12h6M9 16h6',
  bank: 'M3 9l9-5 9 5M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18',
  shield: 'M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z',
  mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  pay: 'M3 6h18v12H3zM3 10h18M7 15h4',
  cart: 'M3 4h3l2.5 11h10L21 7H7M10 20h.01M17 20h.01',
  coin: 'M12 3l9 9-9 9-9-9zM9 12h6',
  gear: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
  logout: 'M15 4h5v16h-5M10 8l-4 4 4 4M6 12h11',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.5',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
