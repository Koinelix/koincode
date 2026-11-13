import { FolderOpen } from "lucide-react";
import { TID_SETTINGS_DATA_BASE_DIR_INPUT } from "@fcode/shared";
import { Input } from "@/components/ui/input.js";

export function DataBaseDirControl({ dataRootDir }: { dataRootDir: string }) {
  return (
    <div className="flex w-[320px] max-w-full min-w-0 items-center gap-2">
      <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
      <Input
        size="lg"
        data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
        value={dataRootDir}
        title={dataRootDir}
        readOnly
        className="min-w-0 flex-1 font-mono"
      />
    </div>
  );
}
