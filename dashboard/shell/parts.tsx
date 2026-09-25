/**
 * Shared page furniture.
 *
 * These compose Astryx primitives into the few shapes the miner repeats on
 * every route: the page frame, a page header with actions, a section heading
 * with a link, and artwork with its fallback.
 */

import {useEffect, useState, type ReactNode} from "react";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Link} from "@astryxdesign/core/Link";
import {Stack} from "@astryxdesign/core/Stack";
import {Layout, LayoutContent} from "@astryxdesign/core/Layout";
import {ArrowIcon, GiftIcon} from "../core/icons";
import {cx} from "../core/util";

/** The page frame: one content line for header, body and footer. */
export function Page({children}: {children: ReactNode}) {
  return (
    <Layout height="fill" className="page">
      <LayoutContent>{children}</LayoutContent>
    </Layout>
  );
}

export interface PageHeaderProps {
  title: string;
  description: string;
  actions?: ReactNode;
}

export function PageHeader({title, description, actions}: PageHeaderProps) {
  return (
    <Stack direction="horizontal" justify="between" align="center" gap={4} className="page-header">
      <Stack gap={0.5}>
        <Heading level={1} id="page-title">
          {title}
        </Heading>
        <Text type="supporting" color="secondary" id="page-kicker">
          {description}
        </Text>
      </Stack>
      <Stack direction="horizontal" gap={2} id="topbar-actions" className="page-actions">
        {actions}
      </Stack>
    </Stack>
  );
}

export interface SectionTitleProps {
  title: string;
  description?: string;
  action?: ReactNode;
  id?: string;
  level?: 2 | 3;
}

/** A region heading: one lead, optional support line, one action. */
export function SectionTitle({title, description, action, id, level = 2}: SectionTitleProps) {
  return (
    <Stack direction="horizontal" justify="between" align="start" gap={4} className="section-title">
      <Stack gap={0.5}>
        <Heading level={level} id={id}>
          {title}
        </Heading>
        {description ? (
          <Text type="supporting" color="secondary">
            {description}
          </Text>
        ) : null}
      </Stack>
      {action}
    </Stack>
  );
}

/** Inline text link with a trailing arrow, used for section navigation. */
export function MoreLink({href, children}: {href: string; children: ReactNode}) {
  return (
    <Link href={href} data-route hasUnderline={false} className="more-link">
      {children}
      <ArrowIcon />
    </Link>
  );
}

export interface ArtworkProps {
  src?: string | null;
  alt?: string;
  className?: string;
}

/**
 * Game/reward artwork with an intentional fallback: a missing Twitch image
 * leaves the gift glyph, never a broken image icon.
 */
export function Artwork({src, alt = "", className}: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={cx("artwork", className)}>
      <GiftIcon />
      {src && !failed ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}
