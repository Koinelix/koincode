import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteAttachmentPurposeButton({ filename, disabled, onUploadOnly }: { filename: string; disabled: boolean; onUploadOnly(): void }) {
  const { intl } = useFCodeIntl(); const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  return <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="secondary" size="icon-xs" disabled={disabled}
    className="absolute bottom-0.5 left-0.5 z-20 size-5 rounded" aria-label={`${t("attachmentPurpose")}: ${filename}`}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><MoreHorizontal className="size-3" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
      <DropdownMenuItem disabled>{t("modelContextNotice")}</DropdownMenuItem>
      <DropdownMenuItem onSelect={onUploadOnly}>{t("convertToUploadOnly")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
