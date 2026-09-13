import React from "react";
import { getMonacoLanguageId, resolveLanguage, type IconKey } from "./languageRegistry";

// --- 1. Custom SVG Branding Logos for Technologies ---

const ReactLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="-11.5 -10.23174 23 20.46348" width={size} height={size} className={className} fill="none">
    <circle r="2.05" fill="#00d8ff" />
    <g stroke="#00d8ff" strokeWidth="1">
      <ellipse rx="11" ry="4.2" />
      <ellipse rx="11" ry="4.2" transform="rotate(60)" />
      <ellipse rx="11" ry="4.2" transform="rotate(120)" />
    </g>
  </svg>
);

const TypeScriptLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="6" fill="#3178c6" />
    <text x="88" y="84" fill="#fff" fontSize="42" fontWeight="800" fontFamily="sans-serif" textAnchor="end">TS</text>
  </svg>
);

const JavaScriptLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="6" fill="#f7df1e" />
    <text x="88" y="84" fill="#000" fontSize="42" fontWeight="800" fontFamily="sans-serif" textAnchor="end">JS</text>
  </svg>
);

const PythonLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 110 110" width={size} height={size} className={className}>
    <path d="M55 2C31.5 2 33.5 12 33.5 12V24h22v3h-31S2 25 2 48.5c0 23.5 10 22.5 10 22.5h9v-13c0-10 8-18 18-18h22s11 1 11-11c0-12 1-31-17-31zm-10 8c3 0 5 2 5 5s-2 5-5 5-5-2-5-5 2-5 5-5z" fill="#3776ab" />
    <path d="M55 108c23.5 0 21.5-10 21.5-10V86h-22v-3h31s22.5 2 22.5-21.5c0-23.5-10-22.5-10-22.5h-9v13c0 10-8 18-18 18H48.5s-11-1-11 11c0 12-1 31 17.5 31zM65 100c-3 0-5-2-5-5s2-5 5-5 5 2 5 5-2 5-5 5z" fill="#ffd343" />
  </svg>
);

const JavaLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className} fill="none">
    <path d="M35 25c2-5-1-10 1-15M48 20c3-5 0-10 2-15M60 22c2-4-1-8 1-12" stroke="#ea2d2e" strokeWidth="3" strokeLinecap="round" />
    <path d="M25 40h45c0 15-5 25-22.5 25S25 55 25 40z" fill="#5382a1" stroke="#3c5f78" strokeWidth="2" />
    <path d="M22 40c0-4 4-7 10-7h26c6 0 10 3 10 7" fill="#5382a1" />
    <path d="M70 45c8 0 8 10 0 12" stroke="#3c5f78" strokeWidth="3" strokeLinecap="round" />
    <path d="M20 70h50c10 0 10 5 0 5H20c-10 0-10-5 0-5z" fill="#ea2d2e" />
  </svg>
);

const HtmlLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 512 512" width={size} height={size} className={className}>
    <path d="M108.4 0h295.2L367 433.8 256 464 145 433.8z" fill="#e34f26" />
    <path d="M256 34.2v395.6l81.5-22.6L363 71.4z" fill="#f06529" />
    <path d="M256 160h-56.2l-3.8-43h60v-43H140.2l11.5 129h104.3zm0 94.6h-54.7l-5.1-57.6h-43.2l9.7 109.1 93.3 25.9z" fill="#ebebeb" />
    <path d="M256 160V117h52.8l-5 55.6-3.8 43H256zm0 94.6v-53.1h50l-4.7 53.1-9.8 109.1-35.5 9.8z" fill="#fff" />
  </svg>
);

const CssLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 512 512" width={size} height={size} className={className}>
    <path d="M108.4 0h295.2L367 433.8 256 464 145 433.8z" fill="#1572b6" />
    <path d="M256 34.2v395.6l81.5-22.6L363 71.4z" fill="#33a9dc" />
    <path d="M256 160h-56.2l-3.8-43h60v-43H140.2l11.5 129h104.3zm0 94.6h-54.7l-5.1-57.6h-43.2l9.7 109.1 93.3 25.9z" fill="#ebebeb" />
    <path d="M256 160V117h52.8l-5 55.6-3.8 43H256zm0 94.6v-53.1h50l-4.7 53.1-9.8 109.1-35.5 9.8z" fill="#fff" />
  </svg>
);

const RustLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <circle cx="50" cy="50" r="32" fill="none" stroke="#e05d44" strokeWidth="8" />
    <text x="50" y="62" fill="#e05d44" fontSize="36" fontWeight="bold" fontFamily="sans-serif" textAnchor="middle">R</text>
    <path d="M50 5v10M50 85v10M5 50h10M85 50h10M18 18l7 7M75 75l7 7M18 82l7-7M75 25l7-7" stroke="#e05d44" strokeWidth="8" strokeLinecap="round" />
  </svg>
);

const JsonLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 128 128" width={size} height={size} className={className}>
    <rect width="128" height="128" rx="8" fill="#2d3748" />
    <text x="64" y="82" fill="#0bc5ea" fontSize="64" fontWeight="900" fontFamily="monospace" textAnchor="middle">{`{}`}</text>
  </svg>
);

const MarkdownLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#08090a" />
    <path d="M15 30h12l10 15 10-15h12v40H47V45L37 60l-10-15v25H15zm50 15h10v15h12L70 75 53 60h12z" fill="#fff" />
  </svg>
);

const SqlLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className} fill="none">
    <ellipse cx="50" cy="30" rx="32" ry="12" fill="#336791" fillOpacity="0.25" stroke="#336791" strokeWidth="6" />
    <path d="M18 30v20c0 6.63 14.33 12 32 12s32-5.37 32-12V30" stroke="#336791" strokeWidth="6" fill="#336791" fillOpacity="0.25" />
    <path d="M18 50v20c0 6.63 14.33 12 32 12s32-5.37 32-12V50" stroke="#336791" strokeWidth="6" fill="#336791" fillOpacity="0.25" />
  </svg>
);

const GitLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="#f05032" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="18" r="3" fill="#f05032" fillOpacity="0.2" />
    <circle cx="6" cy="6" r="3" fill="#f05032" fillOpacity="0.2" />
    <circle cx="6" cy="18" r="3" fill="#f05032" fillOpacity="0.2" />
    <path d="M18 15V9a4 4 0 0 0-4-4H9" />
    <line x1="6" y1="9" x2="6" y2="15" />
  </svg>
);

const DockerLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="#0db7ed">
    <path d="M13.983 8.871h-1.996V6.885h1.996zm2.89 0h-2.002V6.885h2.002zm-5.78 0H9.098V6.885h2.001zm-2.89 0H6.208V6.885h1.999zm2.89-2.99H9.098V3.896h2.001zm-2.89 0H6.208V3.896h1.999zm5.78 0h-1.996V3.896h1.996zm2.89 2.99h-2.002V5.88h2.002zm-8.67 2.99H3.318V8.871h1.999zm18.3 1.157c-.108-.073-.615-.386-1.583-.386-.714 0-1.503.243-2.128.79-.623-.526-1.4-.766-2.096-.766-1.202 0-1.918.59-2.247.925V8.125h-9.84v7.712c0 2.21 1.772 4.025 3.976 4.025h1.272c.102.015.228.03.36.03 2.115 0 4.14-1.396 4.54-3.525.03-.122.046-.228.046-.355.006-.008.016-.014.021-.021.3-.294.67-.586 1.135-.586.327 0 .585.068.761.15 0 .012-.007.025-.007.038-.005.158-.005.347.015.54.12 1.2 1.077 2.203 2.13 2.203.352 0 .72-.116 1.047-.367a7.042 7.042 0 0 0 1.258-1.255c.348-.44.757-1.218.88-2.392.1-.963-.047-1.745-.292-2.185" />
  </svg>
);

const GoLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#00add8" />
    <text x="50" y="68" fill="#fff" fontSize="50" fontWeight="950" fontFamily="sans-serif" textAnchor="middle">GO</text>
  </svg>
);

const PhpLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#777bb4" />
    <text x="50" y="65" fill="#fff" fontSize="38" fontWeight="800" fontFamily="sans-serif" textAnchor="middle">PHP</text>
  </svg>
);

const RubyLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className} fill="none">
    <path d="M50 15L20 40l30 45 30-45-30-25z" fill="#cc342d" />
    <path d="M50 15L35 40h30L50 15z" fill="#e74c3c" />
    <path d="M20 40l15 0 15-25L20 40z" fill="#c0392b" />
    <path d="M80 40l-15 0-15-25L80 40z" fill="#e74c3c" />
  </svg>
);

const CppLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#00599c" />
    <text x="50" y="65" fill="#fff" fontSize="36" fontWeight="900" fontFamily="sans-serif" textAnchor="middle">C++</text>
  </svg>
);

const CLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#659ad2" />
    <text x="50" y="68" fill="#fff" fontSize="46" fontWeight="900" fontFamily="sans-serif" textAnchor="middle">C</text>
  </svg>
);

const ShellLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#202327" />
    <path d="M25 30l25 20-25 20" stroke="#4ade80" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M52 70h23" stroke="#4ade80" strokeWidth="12" strokeLinecap="round" />
  </svg>
);

const EnvLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
    <rect width="100" height="100" rx="8" fill="#ecc94b" />
    <path d="M50 25c-8.8 0-16 7.2-16 16v10H30v24h40V51H66V41c0-8.8-7.2-16-16-16zm-8 16c0-4.4 3.6-8 8-8s8 3.6 8 8v10H42V41zm8 20c2.2 0 4 1.8 4 4s-1.8 4-4 4-4-1.8-4-4 1.8-4 4-4z" fill="#1a202c" />
  </svg>
);

const ConfigLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="#718096" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const ImageLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" fill="#a855f7" stroke="none" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

const DefaultLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="#718096" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

/**
 * Generates a colored-rect-plus-text-label logo, the same shape several
 * hand-written logos above already use (JsonLogo, GoLogo, PhpLogo, CppLogo,
 * CLogo...). Used for languages added in PR 6's coverage pass that don't
 * warrant a bespoke hand-drawn SVG -- each still gets its real brand color,
 * just generated instead of hand-authored per language.
 */
function makeLetterBadgeLogo(
  label: string,
  bg: string,
  fg: string = "#fff",
): React.FC<{ size: number; className?: string }> {
  const fontSize = label.length >= 4 ? 26 : label.length === 3 ? 32 : 42;
  const LetterBadgeLogo: React.FC<{ size: number; className?: string }> = ({ size, className }) => (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className}>
      <rect width="100" height="100" rx="8" fill={bg} />
      <text x="50" y="65" fill={fg} fontSize={fontSize} fontWeight="900" fontFamily="sans-serif" textAnchor="middle">
        {label}
      </text>
    </svg>
  );
  return LetterBadgeLogo;
}

const KotlinLogo = makeLetterBadgeLogo("KT", "#7f52ff");
const ScalaLogo = makeLetterBadgeLogo("SC", "#dc322f");
const SwiftLogo = makeLetterBadgeLogo("SW", "#f05138");
const FSharpLogo = makeLetterBadgeLogo("F#", "#378bba");
const ObjectiveCLogo = makeLetterBadgeLogo("OBJC", "#438eff");
const DartLogo = makeLetterBadgeLogo("DART", "#0175c2");
const RLogo = makeLetterBadgeLogo("R", "#276dc3");
const PowerShellLogo = makeLetterBadgeLogo("PS1", "#012456");
const HclLogo = makeLetterBadgeLogo("TF", "#7b42bc");
const GraphqlLogo = makeLetterBadgeLogo("GQL", "#e10098");
const ProtobufLogo = makeLetterBadgeLogo("PB", "#4285f4");

// --- 2. Filetype Details Mapping ---

export interface FileTypeDetails {
  icon: React.FC<{ size: number; className?: string }>;
  color: string;
  language: string;
}

/**
 * Returns custom SVG icon component, CSS helper class, and Monaco language code based on filename extension.
 *
 * The `language` field is sourced from `languageRegistry.getMonacoLanguageId`
 * so that the Monaco model language id and the LSP server key can never
 * drift apart (see src/services/languageRegistry.ts). Icon selection stays
 * here for now -- PR 6 commit 2 folds it onto the same registry too.
 */
export const getFileTypeDetails = (fileName: string): FileTypeDetails => {
  return { icon: iconForFile(fileName), color: "", language: getMonacoLanguageId(fileName) };
};

/**
 * IconKey -> component (REFACTOR_PLAN.md PR 6 commit 2). This is the only
 * place that still knows about the actual logo components -- icon
 * *selection* (which extension/filename gets which key) now lives in
 * languageRegistry.ts's `RULES`, not here, so the two can never drift back
 * apart the way fileTypeService's icon switch and lspLanguage's id switch
 * once did.
 */
const ICONS: Record<IconKey, React.FC<{ size: number; className?: string }>> = {
  react: ReactLogo,
  typescript: TypeScriptLogo,
  javascript: JavaScriptLogo,
  html: HtmlLogo,
  css: CssLogo,
  json: JsonLogo,
  markdown: MarkdownLogo,
  python: PythonLogo,
  java: JavaLogo,
  rust: RustLogo,
  go: GoLogo,
  ruby: RubyLogo,
  php: PhpLogo,
  cpp: CppLogo,
  c: CLogo,
  sql: SqlLogo,
  shell: ShellLogo,
  config: ConfigLogo,
  env: EnvLogo,
  git: GitLogo,
  docker: DockerLogo,
  kotlin: KotlinLogo,
  scala: ScalaLogo,
  swift: SwiftLogo,
  fsharp: FSharpLogo,
  objectivec: ObjectiveCLogo,
  dart: DartLogo,
  r: RLogo,
  powershell: PowerShellLogo,
  hcl: HclLogo,
  graphql: GraphqlLogo,
  protobuf: ProtobufLogo,
  image: ImageLogo,
  default: DefaultLogo,
};

/** Resolve the technology logo for a file name (used by FileIcon + getFileTypeDetails). */
function iconForFile(fileName: string): React.FC<{ size: number; className?: string }> {
  return ICONS[resolveLanguage(fileName).iconKey];
}

interface FileIconProps {
  fileName: string;
  size?: number;
  className?: string;
}

/**
 * Visual Icon Component for files, displaying the exact technology logo
 */
export const FileIcon: React.FC<FileIconProps> = ({ fileName, size = 14, className = "" }) => {
  const { icon: Icon } = getFileTypeDetails(fileName);
  return <Icon size={size} className={className} />;
};
