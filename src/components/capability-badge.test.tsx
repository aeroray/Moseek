import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CapabilityBadge } from "@/components/capability-badge";
import { adapterStatusLabel } from "@/lib/adapters";
import type { CapabilityStatus } from "@/types/moseek";

describe("the capability badge", () => {
  it("shows the registry's word for every adapter execution state", () => {
    // The badge is what the player shows, and it used to carry its own copy of these words — which is
    // how one source read 需要适配 here and 待适配 in the config centre. A mutation that changed the
    // word in the badge's table passed every test, because the tests checked the registry instead.
    // Rendering the component is what makes that mutation fail.
    const pairs: [CapabilityStatus, string][] = [
      ["supported", adapterStatusLabel("enabled")],
      ["needs-adapter", adapterStatusLabel("needs-adapter")],
    ];
    for (const [status, word] of pairs) {
      const { unmount } = render(<CapabilityBadge status={status} />);
      expect(screen.getByText(word), status).toBeInTheDocument();
      unmount();
    }
  });

  it("no longer names a plugin family for a source it cannot run", () => {
    // `blocked` used to read 已阻止 and was produced by five adapters named after other clients'
    // plugin families (drpy, csp_AppMao, remote JAR, spider, CatVod JS). Those adapters are gone and
    // the entries are removed from the configuration, so the badge says the only thing left to say.
    render(<CapabilityBadge status="blocked" />);
    expect(screen.getByText("不可用")).toBeInTheDocument();
    expect(screen.queryByText("已阻止")).not.toBeInTheDocument();
  });

  it("says 无法适配 for a source that cannot be adapted", () => {
    render(<CapabilityBadge status="needs-adapter" />);
    expect(screen.getByText("无法适配")).toBeInTheDocument();
    expect(screen.queryByText("需要适配")).not.toBeInTheDocument();
    expect(screen.queryByText("待适配")).not.toBeInTheDocument();
  });

  it("keeps its own word for a record the parser could not build", () => {
    // `invalid` is not an adapter execution state, so it is not in the registry.
    render(<CapabilityBadge status="invalid" />);
    expect(screen.getByText("配置无效")).toBeInTheDocument();
  });
});
