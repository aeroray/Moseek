import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  PlugZap,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CapabilityStatus } from "@/types/moseek";

const capabilityConfig: Record<
  CapabilityStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  supported: {
    label: "可用",
    icon: CircleCheck,
    className:
      "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
  },
  partial: {
    label: "部分支持",
    icon: CircleAlert,
    className:
      "border-[color:var(--status-partial-border)] bg-[color:var(--status-partial-bg)] text-[color:var(--status-partial)]",
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
}

export function CapabilityBadge({
  status,
  compact = false,
}: CapabilityBadgeProps) {
  const config = capabilityConfig[status];
  const Icon = config.icon;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", config.className)}
    >
      <Icon className="size-3" data-icon="inline-start" aria-hidden="true" />
      {!compact && config.label}
    </Badge>
  );
}
