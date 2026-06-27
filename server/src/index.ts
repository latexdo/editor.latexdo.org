import Fastify, { type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const port = Number(process.env.PORT ?? 8787);
const dataRoot = process.env.LATEXDO_DATA_ROOT ?? "/data/latexdo";
const maxTextContentLength = 5 * 1024 * 1024;
const maxUploadContentLength = 25 * 1024 * 1024;
const requestBodyLimit = Math.ceil(maxUploadContentLength * 1.4) + 1024 * 1024;
const compileTimeoutMs = 45_000;
const importTimeoutMs = 60_000;
const compileMaxBuffer = 10 * 1024 * 1024;
const engines = new Set(["pdflatex", "xelatex", "lualatex"]);
const importKinds = new Set(["docx", "markdown"]);

const starterDocument = String.raw`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{microtype}
\usepackage{hyperref}

\title{My LatexDo Cloud Document}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Introduction}

Start writing here.

\end{document}
`;

interface ProjectEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: ProjectEntry[];
}

interface OpenProject {
  id: string;
  rootPath: string;
  name: string;
}

interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  detail?: string;
  source?: "latex";
}

interface CompileResult {
  ok: boolean;
  pdfPath?: string;
  durationMs: number;
  output: string;
  diagnostics: Diagnostic[];
  error?: string;
}

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionIndex {
  currentProjectId: string | null;
  projects: ProjectMeta[];
}

interface ImportResult {
  project?: OpenProject;
  relativePath: string;
  sourcePath: string;
  converter: "pandoc";
  warnings: string[];
  mediaFiles: string[];
}

type ExecFileFailure = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  signal?: string;
};

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeSessionId(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return "anonymous";
  const normalized = raw.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
  return normalized || "anonymous";
}

function normalizeProjectId(projectId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(projectId)) {
    throw new Error("Invalid project id.");
  }
  return projectId;
}

function normalizeRelativePath(relativePath: unknown): string {
  if (typeof relativePath !== "string") {
    throw new Error("Path is required.");
  }

  const normalized = normalizeSlashes(relativePath)
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)\.\//g, "$1")
    .replace(/\/+$/, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Use a relative path inside the project.");
  }

  return normalized;
}

function baseName(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

function fileStem(fileName: string): string {
  const name = baseName(fileName).replace(/\.[^.]+$/, "");
  const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "document";
}

function safeUploadName(fileName: unknown, fallback: string): string {
  if (typeof fileName !== "string") return fallback;
  const name = baseName(normalizeSlashes(fileName)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return name || fallback;
}

function starterContent(relativePath: string): string {
  if (baseName(relativePath) === "main.tex") {
    return starterDocument;
  }
  if (relativePath.endsWith(".bib")) {
    return "% Add BibTeX entries here.\n";
  }
  return "";
}

function sessionFromRequest(request: FastifyRequest): string {
  return normalizeSessionId(request.headers["x-latexdo-session"]);
}

function sessionDirectory(sessionId: string): string {
  return path.join(dataRoot, "sessions", sessionId);
}

function projectsDirectory(sessionId: string): string {
  return path.join(sessionDirectory(sessionId), "projects");
}

function indexPath(sessionId: string): string {
  return path.join(sessionDirectory(sessionId), "index.json");
}

function projectDirectory(sessionId: string, projectId: string): string {
  return path.join(projectsDirectory(sessionId), normalizeProjectId(projectId));
}

function cloudRootPath(project: ProjectMeta): string {
  return `cloud://latexdo/${project.id}/${encodeURIComponent(project.name)}`;
}

function toOpenProject(project: ProjectMeta): OpenProject {
  return {
    id: project.id,
    rootPath: cloudRootPath(project),
    name: project.name,
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveProjectPath(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, resolved)) {
    throw new Error("Path escapes the project.");
  }
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSessionIndex(sessionId: string): Promise<SessionIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(sessionId), "utf8")) as Partial<SessionIndex>;
    return {
      currentProjectId:
        typeof parsed.currentProjectId === "string" ? parsed.currentProjectId : null,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.filter(isProjectMeta)
        : [],
    };
  } catch {
    return {
      currentProjectId: null,
      projects: [],
    };
  }
}

function isProjectMeta(value: unknown): value is ProjectMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<ProjectMeta>;
  return (
    typeof meta.id === "string" &&
    typeof meta.name === "string" &&
    typeof meta.createdAt === "number" &&
    typeof meta.updatedAt === "number"
  );
}

async function writeSessionIndex(sessionId: string, index: SessionIndex): Promise<void> {
  await mkdir(sessionDirectory(sessionId), { recursive: true });
  await writeFile(indexPath(sessionId), JSON.stringify(index, null, 2), "utf8");
}

async function createProject(sessionId: string, folderName?: string): Promise<ProjectMeta> {
  const now = Date.now();
  const project: ProjectMeta = {
    id: randomUUID(),
    name: typeof folderName === "string" && folderName.trim() ? folderName.trim() : "LatexDo Cloud Project",
    createdAt: now,
    updatedAt: now,
  };
  const root = projectDirectory(sessionId, project.id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "main.tex"), starterDocument, "utf8");

  const index = await readSessionIndex(sessionId);
  index.projects = [project, ...index.projects];
  index.currentProjectId = project.id;
  await writeSessionIndex(sessionId, index);
  return project;
}

async function currentOrNewProject(sessionId: string): Promise<ProjectMeta> {
  const index = await readSessionIndex(sessionId);
  const current =
    index.projects.find((project) => project.id === index.currentProjectId) ??
    index.projects[0];

  if (current) {
    index.currentProjectId = current.id;
    await writeSessionIndex(sessionId, index);
    await mkdir(projectDirectory(sessionId, current.id), { recursive: true });
    return current;
  }

  return createProject(sessionId);
}

async function findProject(sessionId: string, projectId: string): Promise<ProjectMeta> {
  const normalizedProjectId = normalizeProjectId(projectId);
  const index = await readSessionIndex(sessionId);
  const project = index.projects.find((item) => item.id === normalizedProjectId);
  if (!project) {
    throw new Error("The requested project does not exist in this session.");
  }
  return project;
}

async function touchProject(sessionId: string, projectId: string): Promise<void> {
  const index = await readSessionIndex(sessionId);
  index.currentProjectId = projectId;
  index.projects = index.projects.map((project) =>
    project.id === projectId ? { ...project, updatedAt: Date.now() } : project,
  );
  await writeSessionIndex(sessionId, index);
}

async function listProjectEntries(root: string, directory = root): Promise<ProjectEntry[]> {
  const dirents = await readdir(directory, { withFileTypes: true });
  const result: ProjectEntry[] = [];

  for (const dirent of dirents) {
    if (dirent.name === ".DS_Store" || dirent.name === ".latexdo") {
      continue;
    }

    const absolutePath = path.join(directory, dirent.name);
    const relativePath = normalizeSlashes(path.relative(root, absolutePath));

    if (dirent.isDirectory()) {
      result.push({
        name: dirent.name,
        path: absolutePath,
        relativePath,
        type: "directory",
        children: await listProjectEntries(root, absolutePath),
      });
    } else if (dirent.isFile()) {
      result.push({
        name: dirent.name,
        path: absolutePath,
        relativePath,
        type: "file",
      });
    }
  }

  return result.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function parseTextContent(value: unknown): string {
  if (typeof value !== "string" || value.length > maxTextContentLength) {
    throw new Error("Invalid file content.");
  }
  return value;
}

function parseBase64Content(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new Error("Uploaded content is required.");
  }

  const normalized = value.replace(/\s/g, "");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Uploaded content must be base64 encoded.");
  }

  const content = Buffer.from(normalized, "base64");
  if (content.byteLength > maxUploadContentLength) {
    throw new Error("Uploaded files are limited to 25 MB each.");
  }

  return content;
}

function warningsFromPandoc(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function flattenEntries(entries: ProjectEntry[]): ProjectEntry[] {
  const result: ProjectEntry[] = [];
  for (const entry of entries) {
    result.push(entry);
    if (entry.children) result.push(...flattenEntries(entry.children));
  }
  return result;
}

async function uniqueTexPath(projectRoot: string, desiredPath: string): Promise<string> {
  const normalized = normalizeRelativePath(desiredPath);
  if (!(await exists(resolveProjectPath(projectRoot, normalized)))) {
    return normalized;
  }

  const extension = path.posix.extname(normalized) || ".tex";
  const withoutExtension = normalized.slice(0, -extension.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${withoutExtension}-${index}${extension}`;
    if (!(await exists(resolveProjectPath(projectRoot, candidate)))) {
      return candidate;
    }
  }

  throw new Error("Could not choose an output path for the imported document.");
}

async function projectForImport(
  sessionId: string,
  projectId: unknown,
  sourceName: string,
): Promise<{ project: ProjectMeta; created: boolean }> {
  if (typeof projectId === "string" && projectId.trim()) {
    return { project: await findProject(sessionId, projectId), created: false };
  }

  return {
    project: await createProject(sessionId, fileStem(sourceName)),
    created: true,
  };
}

async function importWithPandoc(
  projectRoot: string,
  kind: string,
  sourceName: string,
  content: Buffer,
  outputPath: string,
): Promise<{ warnings: string[]; mediaFiles: string[] }> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "latexdo-import-"));
  const sourcePath = path.join(tempDirectory, sourceName);

  try {
    await mkdir(path.dirname(resolveProjectPath(projectRoot, outputPath)), { recursive: true });
    await writeFile(sourcePath, content);

    const args =
      kind === "docx"
        ? [
            sourcePath,
            "--from=docx",
            "--to=latex",
            "--standalone",
            "--extract-media=.",
            "-o",
            outputPath,
          ]
        : [sourcePath, "--from=gfm", "--to=latex", "--standalone", "-o", outputPath];

    const { stderr } = await execFileAsync("pandoc", args, {
      cwd: projectRoot,
      timeout: importTimeoutMs,
      maxBuffer: compileMaxBuffer,
    });

    const entries = flattenEntries(await listProjectEntries(projectRoot));
    return {
      warnings: warningsFromPandoc(stderr ?? ""),
      mediaFiles: entries
        .filter((entry) => entry.type === "file" && entry.relativePath.startsWith("media/"))
        .map((entry) => entry.relativePath),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function engineArgs(engine: string): string[] {
  switch (engine) {
    case "xelatex":
      return [
        "-pdfxe",
        "-xelatex=xelatex -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape %O %S",
      ];
    case "lualatex":
      return [
        "-pdflua",
        "-lualatex=lualatex -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape %O %S",
      ];
    case "pdflatex":
    default:
      return [
        "-pdf",
        "-pdflatex=pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape %O %S",
      ];
  }
}

function diagnosticFromOutput(rootFile: string, output: string): Diagnostic[] {
  const fileLine = output.match(/([^\s:]+\.tex):(\d+):\s*([^\n]+)/);
  if (fileLine) {
    return [
      {
        file: fileLine[1] || rootFile,
        line: Number(fileLine[2] || 1),
        column: 1,
        severity: "error",
        message: fileLine[3] || "LaTeX compilation failed.",
        detail: "Cloud compiler reported this line while running latexmk.",
        source: "latex",
      },
    ];
  }

  return [
    {
      file: rootFile,
      line: 1,
      column: 1,
      severity: "error",
      message: "LaTeX compilation failed.",
      detail: output.slice(0, 1000) || "latexmk exited with an error.",
      source: "latex",
    },
  ];
}

async function compileProject(
  projectRoot: string,
  rootFile: string,
  engine: string,
): Promise<CompileResult> {
  if (!engines.has(engine)) {
    throw new Error("Unsupported LaTeX engine.");
  }
  const normalizedRootFile = normalizeRelativePath(rootFile);
  if (!normalizedRootFile.endsWith(".tex")) {
    throw new Error("Root file must be a .tex file.");
  }

  const absoluteRootFile = resolveProjectPath(projectRoot, normalizedRootFile);
  if (!(await exists(absoluteRootFile))) {
    throw new Error(`Root file ${normalizedRootFile} does not exist.`);
  }

  const startedAt = Date.now();
  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    ...engineArgs(engine),
    normalizedRootFile,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("latexmk", args, {
      cwd: projectRoot,
      timeout: compileTimeoutMs,
      maxBuffer: compileMaxBuffer,
    });
    const output = `${stdout ?? ""}${stderr ?? ""}`;
    const pdfPath = normalizedRootFile.replace(/\.tex$/i, ".pdf");
    const pdfExists = await exists(resolveProjectPath(projectRoot, pdfPath));

    return {
      ok: pdfExists,
      pdfPath: pdfExists ? pdfPath : undefined,
      durationMs: Date.now() - startedAt,
      output,
      diagnostics: pdfExists ? [] : diagnosticFromOutput(normalizedRootFile, output),
      error: pdfExists ? undefined : "latexmk finished without producing a PDF.",
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ? `\n${failure.message}` : ""}`;
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      output,
      diagnostics: diagnosticFromOutput(normalizedRootFile, output),
      error:
        failure.signal === "SIGTERM"
          ? "Compilation timed out."
          : "LaTeX compilation failed.",
    };
  }
}

const app = Fastify({
  logger: true,
  bodyLimit: requestBodyLimit,
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const message = error instanceof Error ? error.message : "Request failed.";
  void reply.status(400).send({ error: message });
});

app.get("/api/health", async () => ({ ok: true }));

app.post("/api/projects/open", async (request) => {
  const sessionId = sessionFromRequest(request);
  const project = await currentOrNewProject(sessionId);
  return toOpenProject(project);
});

app.post("/api/projects", async (request) => {
  const sessionId = sessionFromRequest(request);
  const body = request.body as { folderName?: unknown } | null;
  const project = await createProject(
    sessionId,
    typeof body?.folderName === "string" ? body.folderName : undefined,
  );
  return toOpenProject(project);
});

app.get("/api/projects/:projectId/files", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  await findProject(sessionId, projectId);
  const root = projectDirectory(sessionId, projectId);
  return listProjectEntries(root);
});

app.get("/api/projects/:projectId/files/content", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const query = request.query as { path?: unknown };
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(query.path);
  const root = projectDirectory(sessionId, projectId);
  const content = await readFile(resolveProjectPath(root, relativePath), "utf8");
  return { content };
});

app.put("/api/projects/:projectId/files/content", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const query = request.query as { path?: unknown };
  const body = request.body as { content?: unknown } | null;
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(query.path);
  const content = parseTextContent(body?.content);
  const root = projectDirectory(sessionId, projectId);
  const absolutePath = resolveProjectPath(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  await touchProject(sessionId, projectId);
  return undefined;
});

app.put("/api/projects/:projectId/files/blob", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const query = request.query as { path?: unknown };
  const body = request.body as { contentBase64?: unknown } | null;
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(query.path);
  const content = parseBase64Content(body?.contentBase64);
  const root = projectDirectory(sessionId, projectId);
  const absolutePath = resolveProjectPath(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  await touchProject(sessionId, projectId);
  return { relativePath, size: content.byteLength };
});

app.get("/api/projects/:projectId/files/exists", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const query = request.query as { path?: unknown };
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(query.path);
  const root = projectDirectory(sessionId, projectId);
  return { exists: await exists(resolveProjectPath(root, relativePath)) };
});

app.post("/api/projects/:projectId/files", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const body = request.body as { relativePath?: unknown; type?: unknown } | null;
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(body?.relativePath);
  const root = projectDirectory(sessionId, projectId);
  const absolutePath = resolveProjectPath(root, relativePath);

  if (body?.type === "directory") {
    await mkdir(absolutePath, { recursive: false });
  } else if (body?.type === "file") {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (!(await exists(absolutePath))) {
      await writeFile(absolutePath, starterContent(relativePath), "utf8");
    }
  } else {
    throw new Error("File type must be file or directory.");
  }

  await touchProject(sessionId, projectId);
  return { relativePath };
});

app.post("/api/projects/:projectId/files/move", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const body = request.body as {
    fromRelativePath?: unknown;
    toRelativePath?: unknown;
  } | null;
  await findProject(sessionId, projectId);
  const fromRelativePath = normalizeRelativePath(body?.fromRelativePath);
  const toRelativePath = normalizeRelativePath(body?.toRelativePath);
  const root = projectDirectory(sessionId, projectId);
  const from = resolveProjectPath(root, fromRelativePath);
  const to = resolveProjectPath(root, toRelativePath);

  if (from === to) return { relativePath: toRelativePath };
  if (isInside(from, to)) throw new Error("Cannot move a folder into itself.");
  if (await exists(to)) throw new Error(`"${toRelativePath}" already exists.`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  await touchProject(sessionId, projectId);
  return { relativePath: toRelativePath };
});

app.post("/api/import/:kind", async (request) => {
  const sessionId = sessionFromRequest(request);
  const { kind } = request.params as { kind: string };
  const body = request.body as {
    projectId?: unknown;
    fileName?: unknown;
    contentBase64?: unknown;
  } | null;

  if (!importKinds.has(kind)) {
    throw new Error("Import type must be docx or markdown.");
  }

  const sourceName = safeUploadName(
    body?.fileName,
    kind === "docx" ? "document.docx" : "document.md",
  );
  const content = parseBase64Content(body?.contentBase64);
  const { project, created } = await projectForImport(sessionId, body?.projectId, sourceName);
  const root = projectDirectory(sessionId, project.id);
  const desiredOutputPath = created ? "main.tex" : `${fileStem(sourceName)}.tex`;
  const outputPath = created
    ? desiredOutputPath
    : await uniqueTexPath(root, desiredOutputPath);

  const importResult = await importWithPandoc(root, kind, sourceName, content, outputPath);
  await touchProject(sessionId, project.id);

  return {
    project: created ? toOpenProject(project) : undefined,
    relativePath: outputPath,
    sourcePath: sourceName,
    converter: "pandoc",
    warnings: importResult.warnings,
    mediaFiles: importResult.mediaFiles,
  } satisfies ImportResult;
});

app.post("/api/compile", async (request) => {
  const sessionId = sessionFromRequest(request);
  const body = request.body as {
    projectId?: unknown;
    rootFile?: unknown;
    engine?: unknown;
  } | null;

  if (typeof body?.projectId !== "string") throw new Error("Project id is required.");
  if (typeof body.rootFile !== "string") throw new Error("Root file is required.");
  const engine = typeof body.engine === "string" ? body.engine : "pdflatex";
  await findProject(sessionId, body.projectId);
  const root = projectDirectory(sessionId, body.projectId);
  const result = await compileProject(root, body.rootFile, engine);
  await touchProject(sessionId, body.projectId);
  return result;
});

app.get("/api/projects/:projectId/pdf", async (request, reply) => {
  const sessionId = sessionFromRequest(request);
  const { projectId } = request.params as { projectId: string };
  const query = request.query as { path?: unknown };
  await findProject(sessionId, projectId);
  const relativePath = normalizeRelativePath(query.path);
  if (!relativePath.endsWith(".pdf")) {
    throw new Error("PDF path must end with .pdf.");
  }
  const root = projectDirectory(sessionId, projectId);
  const pdf = await readFile(resolveProjectPath(root, relativePath));
  return reply.type("application/pdf").send(pdf);
});

await mkdir(dataRoot, { recursive: true });
await app.listen({ host: "0.0.0.0", port });
