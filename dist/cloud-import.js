(function () {
  const sessionKey = "latexdo.cloud.session";
  const maxFileBytes = 25 * 1024 * 1024;
  const maxTotalBytes = 80 * 1024 * 1024;
  const maxFileCount = 1000;
  const ignoredDirectories = new Set([".git", "node_modules", ".latexdo"]);
  const ignoredNames = new Set([".DS_Store"]);

  function message(error) {
    return error instanceof Error ? error.message : String(error || "Request failed.");
  }

  function sessionId() {
    const existing = window.localStorage.getItem(sessionKey);
    if (existing) return existing;
    const generated =
      (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(sessionKey, generated);
    return generated;
  }

  async function cloudRequest(path, options) {
    const headers = new Headers((options && options.headers) || {});
    if (options && options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("x-latexdo-session", sessionId());

    const response = await fetch(path, {
      ...(options || {}),
      headers,
    });

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        detail = body.error || detail;
      } catch {
        // Keep the HTTP status when the response is not JSON.
      }
      throw new Error(detail);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  function cleanRelativePath(value) {
    const parts = String(value || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);
    const safe = [];

    for (const part of parts) {
      if (part === "." || part === ".." || part.includes("\0")) return null;
      if (ignoredDirectories.has(part)) return null;
      safe.push(part);
    }

    if (!safe.length || ignoredNames.has(safe[safe.length - 1])) return null;
    return safe.join("/");
  }

  function stripTopDirectory(value) {
    const parts = String(value || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);
    return parts.length > 1 ? parts.slice(1).join("/") : parts.join("/");
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("Could not read file."));
      reader.onload = () => {
        const value = String(reader.result || "");
        const comma = value.indexOf(",");
        resolve(comma === -1 ? value : value.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  function canPickDirectory() {
    if ("showDirectoryPicker" in window) return true;
    const input = document.createElement("input");
    return "webkitdirectory" in input;
  }

  async function collectDirectory(handle, prefix, items) {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory" && ignoredDirectories.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === "file") {
        items.push({ file: await entry.getFile(), relativePath });
      } else {
        await collectDirectory(entry, relativePath, items);
      }
    }
  }

  function fileInput(options) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      let settled = false;

      input.type = "file";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      if (options.accept) input.accept = options.accept;
      if (options.directory) {
        input.multiple = true;
        input.setAttribute("webkitdirectory", "");
      }

      function cleanup() {
        input.remove();
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      input.addEventListener("change", () => finish(input.files), { once: true });
      input.addEventListener("cancel", () => finish(null), { once: true });
      window.setTimeout(() => {
        window.addEventListener(
          "focus",
          () => {
            window.setTimeout(() => {
              if (!settled && (!input.files || !input.files.length)) finish(null);
            }, 250);
          },
          { once: true },
        );
      }, 0);

      document.body.append(input);
      input.click();
    });
  }

  async function pickDirectory() {
    if ("showDirectoryPicker" in window) {
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        const items = [];
        await collectDirectory(handle, "", items);
        return { name: handle.name, items };
      } catch (error) {
        if (error && error.name === "AbortError") return null;
        throw error;
      }
    }

    const files = await fileInput({ directory: true });
    if (!files || !files.length) return null;
    const items = Array.from(files).map((file) => ({
      file,
      relativePath: stripTopDirectory(file.webkitRelativePath || file.name),
    }));
    const firstPath = files[0].webkitRelativePath || "";
    const folderName = firstPath.split("/").filter(Boolean)[0] || "Imported Project";
    return { name: folderName, items };
  }

  async function pickSingleFile(accept) {
    const files = await fileInput({ accept });
    return files && files.length ? files[0] : null;
  }

  function filterItems(items) {
    const accepted = [];
    let skipped = 0;
    let total = 0;

    for (const item of items) {
      const relativePath = cleanRelativePath(item.relativePath);
      if (!relativePath || item.file.size > maxFileBytes) {
        skipped += 1;
        continue;
      }
      if (accepted.length >= maxFileCount || total + item.file.size > maxTotalBytes) {
        skipped += 1;
        continue;
      }
      accepted.push({ file: item.file, relativePath });
      total += item.file.size;
    }

    return { accepted, skipped };
  }

  async function importProjectFolder() {
    const selection = await pickDirectory();
    if (!selection) return undefined;

    const { accepted, skipped } = filterItems(selection.items);
    if (!accepted.length) {
      window.alert("No importable files were found in that folder.");
      return undefined;
    }

    const project = await cloudRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({ folderName: selection.name || "Imported Project" }),
    });

    for (const item of accepted) {
      const contentBase64 = await fileToBase64(item.file);
      await cloudRequest(
        `/api/projects/${project.id}/files/blob?path=${encodeURIComponent(item.relativePath)}`,
        {
          method: "PUT",
          body: JSON.stringify({ contentBase64 }),
        },
      );
    }

    if (skipped) {
      window.alert(
        `Imported ${accepted.length} files. Skipped ${skipped} hidden or oversized files.`,
      );
    }

    return project;
  }

  async function importDocument(kind, projectId) {
    const accept =
      kind === "docx"
        ? ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : ".md,.markdown,text/markdown,text/plain";
    const file = await pickSingleFile(accept);
    if (!file) return undefined;

    return cloudRequest(`/api/import/${kind}`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        fileName: file.name,
        contentBase64: await fileToBase64(file),
      }),
    });
  }

  function install() {
    const api = window.latexdo;
    if (!api || api.__cloudImportInstalled) return Boolean(api && api.__cloudImportInstalled);

    const originalOpenProject =
      typeof api.openProject === "function" ? api.openProject.bind(api) : null;

    api.openProject = async () => {
      try {
        if (canPickDirectory()) return importProjectFolder();
        return originalOpenProject ? originalOpenProject() : undefined;
      } catch (error) {
        window.alert(`Could not import folder: ${message(error)}`);
        return undefined;
      }
    };

    api.importMarkdown = async (projectId) => {
      try {
        return await importDocument("markdown", projectId);
      } catch (error) {
        window.alert(`Could not import Markdown: ${message(error)}`);
        return undefined;
      }
    };

    api.importDocx = async (projectId) => {
      try {
        return await importDocument("docx", projectId);
      } catch (error) {
        window.alert(`Could not import DOCX: ${message(error)}`);
        return undefined;
      }
    };

    api.__cloudImportInstalled = true;
    return true;
  }

  if (!install()) {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (install() || Date.now() - startedAt > 10000) {
        window.clearInterval(timer);
      }
    }, 50);
  }
})();
