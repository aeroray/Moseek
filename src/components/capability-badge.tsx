import {
  Ban,
  CircleCheck,
  CircleHelp,
  PlugZap,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { adapterStatusLabel } from "@/lib/adapters";
import { cn } from "@/lib/utils";
import type { CapabilityStatus } from "@/types/moseek";

/**
 * The words for each capability.
 *
 * There is no 部分支持 entry because there is no `partial` status: nothing in the codebase could
 * assign it, and it only ever reached the screen from stale stored data, where it sat next to an
 * adapter badge saying 没有可用适配器.
 *
 * **`supported` and `needs-adapter` take their words from the adapter registry** rather than
 * restating them. They are the same two words the adapter column and the filter panel use, and
 * writing them out again here is exactly how `needs-adapter` came to read 需要适配 on this badge and
 * 待适配 everywhere else — one source described two ways depending on the screen. A mutation that
 * changed the word here passed every test, because the tests were checking the registry's copy.
 *
 * `blocked` and `invalid` keep their own words, because neither is an adapter execution state.
 * `blocked` now means one thing only — a scheme that must never be fetched — and the sources carrying
 * it are removed from the configuration, so this entry is the model's remnant rather than something
 * a reader meets. It says 不可用 rather than naming a plugin family, which is what it used to do and
 * what told the reader nothing.
 */
const capabilityConfig: Record<
  CapabilityStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  supported: {
    label: adapterStatusLabel("enabled"),
    icon: CircleCheck,
    className:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
  },
  "needs-adapter": {
    label: adapterStatusLabel("needs-adapter"),
    icon: PlugZap,
    className:
      "border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
  },
  blocked: {
    label: "不可用",
    icon: Ban,
    className:
      "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
  },
  invalid: {
    label: "配置无效",
    icon: CircleHelp,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

interface CapabilityBadgeProps {
  status: CapabilityStatus;
  compact?: boolean;
  /**
   * Overrides the wording while keeping the status's colour and icon.
   *
   * The adapter verdict and the test verdict are different questions — "we can run this" versus
   * "this actually works" — but they share a palette. This lets a caller say 待测试 in the
   * adapter colour without redefining the status.
   */
  label?: string;
  className?: string;
}

export function CapabilityBadge({
  status,
  compact = false,
  label,
  className,
}: CapabilityBadgeProps) {
  const config = capabilityConfig[status];
  const Icon = config.icon;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", config.className, className)}
    >
      <Icon className="size-3" data-icon="inline-start" aria-hidden="true" />
      {!compact && (label ?? config.label)}
    </Badge>
  );
}
