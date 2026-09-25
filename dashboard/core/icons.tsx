/**
 * Inline SVG icon set.
 *
 * The dashboard has no icon CDN dependency: every glyph is a local SVG
 * component that inherits `currentColor`, so icons follow the active theme
 * without a sprite sheet.
 */

import type {SVGProps} from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({children, ...props}: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Intrinsic size: components that slot an icon without styling it (or a
      // stripped StyleX context) must never fall back to the 300×150 default.
      width={18}
      height={18}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function CampaignIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5Z" />
      <path d="M14 5v2M14 11v2M14 17v2" />
    </Svg>
  );
}

export function MiningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m13 2-8 12h6l-1 8 9-12h-6z" />
    </Svg>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4.5l3 1.8" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2.6" />
      <circle cx="15" cy="17" r="2.6" />
    </Svg>
  );
}

export function GiftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z" />
    </Svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5v14M16 5v14" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m8 4 12 8-12 8z" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
    </Svg>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12H5m5 5-5-5 5-5" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12 4 4L19 6" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m21 21-6-6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 15 6-6 6 6" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function DiamondIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 4 12l8 9 8-9z" />
    </Svg>
  );
}

/** The brand mark: a stacked ore block. */
export function BrandMark(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <path d="m12 3 8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10M8 5l8 4" />
    </Svg>
  );
}
