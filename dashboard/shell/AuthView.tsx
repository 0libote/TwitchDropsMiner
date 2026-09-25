/**
 * Device authorization screen.
 *
 * Shown before the miner has a Twitch session: the user opens Twitch's
 * activation page, types the one-time code and returns here.
 */

import {useEffect, useState} from "react";
import {Card} from "@astryxdesign/core/Card";
import {Button} from "@astryxdesign/core/Button";
import {Heading, Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {StatusDot} from "@astryxdesign/core/StatusDot";
import {BrandMark, CheckIcon, ExternalIcon} from "../core/icons";
import {useStore} from "../core/store";
import {cx} from "../core/util";

const STEPS = [
  "Open the Twitch authorization page.",
  "Enter this one-time code.",
  "Return here. Mining starts automatically after approval.",
];

export function AuthView() {
  const {state} = useStore();
  const [copied, setCopied] = useState(false);
  const code = state.login.activationCode ?? "—";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <section id="auth-view" className="auth-view" aria-labelledby="auth-title">
      <Stack direction="horizontal" gap={2} align="center" className="auth-brand">
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
        </span>
        <Text weight="semibold">Twitch Drops Miner</Text>
      </Stack>

      <Card className="auth-card">
        <Stack gap={5}>
          <Stack gap={1.5}>
            <Text type="label" color="accent" className="kicker">
              Connect Twitch
            </Text>
            <Heading level={1} id="auth-title">
              Authorize this miner
            </Heading>
            <Text color="secondary" className="auth-intro">
              Use Twitch’s device authorization page to connect your account. Your password never
              passes through this app.
            </Text>
          </Stack>

          <ol className="auth-steps">
            {STEPS.map((step, index) => (
              <li key={step}>
                <span className="auth-step-index" aria-hidden="true">
                  {index === 1 ? <CheckIcon /> : index + 1}
                </span>
                <div>
                  <Text>{step}</Text>
                  {index === 1 ? (
                    <strong id="activation-code" className="activation-code">
                      {code}
                    </strong>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          <Stack direction="horizontal" gap={2} className="auth-actions">
            <Button
              variant="primary"
              label="Open Twitch authorization"
              href={state.login.activationUrl ?? undefined}
              icon={<ExternalIcon />}
              target="_blank"
              rel="noreferrer"
            />
            <Button
              variant="secondary"
              label={copied ? "Copied" : "Copy code"}
              onClick={() => {
                navigator.clipboard
                  .writeText(code)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            />
          </Stack>

          <Stack direction="horizontal" gap={2} align="center" className="auth-status">
            <StatusDot variant="warning" label="Waiting for authorization" />
            <Text type="supporting" color="secondary">
              {state.status || "Waiting for authorization"}
            </Text>
          </Stack>
        </Stack>
      </Card>
    </section>
  );
}
