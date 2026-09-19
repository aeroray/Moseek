import {
  Ban,
  CircleCheck,
  CircleHelp,
  PlugZap,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CapabilityStatus } from "@/types/moseek";

/**
 * The words for each capability.
 *
 * There is no 部分支持 entry because there is no `partial` status: nothing in the codebase could
 * assign it, and it only ever reached the screen from stale stored data, where it sat next to an
 * adapter badge saying 没有可用适配器.
 *
 * "supported" reads 可执行 rather than 可用. It describes what Moseek can do — run the source — not
 * whether the source works, which is only known after a test. Calling it 可用 claimed the resource
 * was healthy when all we knew was that we had a way to ask.
 */
const capabilityConfig: Record<
  CapabilityStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  supported: {
    label: "可执行",
    icon: CircleCheck,
    className:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
  },
  "needs-adapter": {
    label: "需要适配",
    icon: PlugZap,
    className:
      "border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
  },
  blocked: {
    label: "已阻止",
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
