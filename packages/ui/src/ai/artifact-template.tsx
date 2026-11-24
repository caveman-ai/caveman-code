// ), apps/web/src/components/ChatMarkdown.tsx
// CodexArtifactTemplateCard @ 13aa882c22, adapted to the Caveman UI kit.
import { Icon, Comment01Icon, FileSpreadsheetIcon, FileTextIcon, Image01Icon, InternetIcon, Mail01Icon, Presentation01Icon, SparklesIcon, type IconSvgElement } from "../icons/huge";
import { codexArtifactTemplatePresentationLabel, type CodexArtifactTemplate, type CodexArtifactTemplateKind } from "@caveman-app/shared/codexArtifactTemplates";
import { Button } from "../components/button.tsx";

const ICONS = {
  document: FileTextIcon,
  presentation: Presentation01Icon,
  spreadsheet: FileSpreadsheetIcon,
  site: InternetIcon,
  "google-docs": FileTextIcon,
  "google-slides": Presentation01Icon,
  "google-sheets": FileSpreadsheetIcon,
  image: Image01Icon,
  email: Mail01Icon,
  slack: Comment01Icon,
} satisfies Record<CodexArtifactTemplateKind, IconSvgElement>;

/** A template is a skill suggestion, not a generated image or a request to run anything. */
export function ArtifactTemplateCard({ template, onUse }: { template: CodexArtifactTemplate; onUse?: ((template: CodexArtifactTemplate) => void) | undefined }) {
  const glyph = ICONS[template.artifactKind];
  const label = codexArtifactTemplatePresentationLabel(template.artifactKind);
  return (
    <div
      role="group"
      aria-label={`${template.displayName} template`}
      data-slot="artifact-template"
      data-artifact-kind={template.artifactKind}
      data-gallery-kind={template.galleryKind}
      data-skill-name={template.skillName}
      className="my-3 flex w-full min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 first:mt-0 last:mb-0"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden="true" className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
          <Icon icon={glyph} className="size-5" />
          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border border-background bg-primary text-primary-foreground">
            <Icon icon={SparklesIcon} className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground" title={template.displayName}>{template.displayName}</div>
          <div className="text-[12px] text-muted-foreground">{label}</div>
        </div>
      </div>
      {onUse ? <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => onUse(template)}>Use template</Button> : null}
    </div>
  );
}
