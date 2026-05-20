(function () {
  const { createElement: createReactElement, cloneElement, isValidElement, useEffect, useMemo, useRef, useState } = React;

  function h(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).map(function (child, index) {
      return withFallbackKeys(child, String(index));
    });
    return createReactElement.apply(null, [type, props].concat(children));
  }

  function withFallbackKeys(child, path) {
    if (!Array.isArray(child)) return child;
    return child.map(function (entry, index) {
      const nextPath = path + "." + String(index);
      if (Array.isArray(entry)) {
        return withFallbackKeys(entry, nextPath);
      }
      if (isValidElement(entry) && entry.key == null) {
        return cloneElement(entry, { key: "auto-" + nextPath });
      }
      return entry;
    });
  }

  // ── Build identity ──
  // Updated manually each deploy so the UI shows what version is running.
  const WEB_BUILD_TIME = "2026-05-20T13:00:00.000Z";
  const WEB_BUILD_LABEL = "2026-05-20 13:00 UTC";

  function App() {
    const [projects, setProjects] = useState([]);
    const [activeProjectId, setActiveProjectId] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [activeTaskId, setActiveTaskId] = useState(null);
    const [taskDetail, setTaskDetail] = useState(null);
    const [taskContext, setTaskContext] = useState(null);
    const [thread, setThread] = useState(null);
    const [projectThread, setProjectThread] = useState(null);
    const [session, setSession] = useState(null);
    const [view, setView] = useState("home");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [folderNotice, setFolderNotice] = useState(null);
    const [selectedContextFilePath, setSelectedContextFilePath] = useState("");
    const [selectedContextFileContent, setSelectedContextFileContent] = useState("");
    const [selectedContextFileLoading, setSelectedContextFileLoading] = useState(false);
    const [streamingTaskReply, setStreamingTaskReply] = useState("");
    const [streamingProjectReply, setStreamingProjectReply] = useState("");
    const [executors, setExecutors] = useState([]);
    const [activeRun, setActiveRun] = useState(null);
    const [taskRuns, setTaskRuns] = useState([]);
    const [lastCompletedRun, setLastCompletedRun] = useState(null);
    const pollIntervalRef = useRef(null);
    const [planningTasks, setPlanningTasks] = useState([]);
    const [showAddTaskForm, setShowAddTaskForm] = useState(false);
    const [deletingDraft, setDeletingDraft] = useState(false);
    const [showImportPlanForm, setShowImportPlanForm] = useState(false);
    const [importPlanText, setImportPlanText] = useState("");
    const [addTaskTitle, setAddTaskTitle] = useState("");
    const [planningBusy, setPlanningBusy] = useState(false);
    const [cliTestResults, setCliTestResults] = useState({});
    const [recentRuns, setRecentRuns] = useState([]);
    const [projectSummary, setProjectSummary] = useState(null);
    const [projectTaskSummary, setProjectTaskSummary] = useState(null);
    const [draftInput, setDraftInput] = useState("");
    const [homeDraftInput, setHomeDraftInput] = useState("");
    const [editingProjectTitle, setEditingProjectTitle] = useState(false);
    const [projectRenameDraft, setProjectRenameDraft] = useState("");
    const [editingTaskTitle, setEditingTaskTitle] = useState(false);
    const [taskRenameDraft, setTaskRenameDraft] = useState("");
    const [projectOverviewExpanded, setProjectOverviewExpanded] = useState(false);
    const [handoffPreviewText, setHandoffPreviewText] = useState("");
    const [connectionGuideVisible, setConnectionGuideVisible] = useState(false);
    const [advancedGuideVisible, setAdvancedGuideVisible] = useState(false);
    const [capabilityMenuVisible, setCapabilityMenuVisible] = useState(false);
    const [externalApiToken, setExternalApiToken] = useState("");
    const [executorConfig, setExecutorConfig] = useState({
      codexCommand: "",
      claudeCommand: ""
    });
    const [connectedClients, setConnectedClients] = useState([]);
    const [aiConfig, setAIConfig] = useState({
      providerPreset: "openai-gpt",
      provider: "openai-compatible",
      apiKey: "",
      baseUrl: "",
      model: "",
      codexBin: ""
    });
    const [runtimeInfo, setRuntimeInfo] = useState(null);
    const activeProjectIdRef = useRef(null);
    const activeTaskIdRef = useRef(null);

    useEffect(function () {
      void boot(null);
      return function () {
        clearRunPoll();
      };
    }, []);

    useEffect(function () {
      activeProjectIdRef.current = activeProjectId;
    }, [activeProjectId]);

    useEffect(function () {
      activeTaskIdRef.current = activeTaskId;
    }, [activeTaskId]);

    // Periodic connected clients polling
    useEffect(function () {
      refreshConnectedClients();
      var pollId = setInterval(function () {
        refreshConnectedClients();
      }, 30000);
      return function () { clearInterval(pollId); };
    }, [activeProjectId]);

    async function boot(targetProjectId) {
      setLoading(true);
      setError("");

      try {
        const desktopApi = getDesktopApi();
        const [projectsRes, sessionRes, aiConfigRes, recentProjectsRes, executorsRes, executorConfigRes, recentRunsRes, summaryRes] = await Promise.all([
          fetchJson("/api/desktop/projects"),
          fetchJson("/api/desktop/session"),
          fetchJson("/api/desktop/ai-config"),
          desktopApi && typeof desktopApi.getRecentProjects === "function"
            ? desktopApi.getRecentProjects()
            : Promise.resolve({ projects: [] }),
          fetchJson("/api/desktop/executors").catch(function () { return { executors: [] }; }),
          fetchJson("/api/desktop/executor-config").catch(function () { return { config: { codexCommand: "", claudeCommand: "" } }; }),
          fetchJson("/api/desktop/runs/recent").catch(function () { return { runs: [] }; }),
          fetchJson("/api/desktop/summary").catch(function () { return { summary: null }; }),
        ]);

        const currentProjects = Array.isArray(projectsRes.projects) ? projectsRes.projects : [];
        const recentProjects = Array.isArray(recentProjectsRes && recentProjectsRes.projects) ? recentProjectsRes.projects : [];
        const mergedProjects = recentProjects.slice();
        currentProjects.forEach(function (project) {
          const existingIndex = mergedProjects.findIndex(function (existing) {
            return existing && project && existing.rootPath === project.rootPath;
          });
          if (existingIndex >= 0) {
            mergedProjects[existingIndex] = {
              ...mergedProjects[existingIndex],
              ...project
            };
            return;
          }
          mergedProjects.push(project);
        });
        const nextProjects = mergedProjects;
        if (nextProjects.length > 0) {
          setFolderNotice(null);
        }
        const nextSession = sessionRes.session || null;
        const initialProjectId = targetProjectId && nextProjects.some(function (project) { return project.id === targetProjectId; })
          ? targetProjectId
          : nextSession && nextSession.activeProjectId && nextProjects.some(function (project) { return project.id === nextSession.activeProjectId; })
            ? nextSession.activeProjectId
            : nextProjects[0]
              ? nextProjects[0].id
              : null;

        setProjects(nextProjects);
        setSession(nextSession);
        setExecutors(Array.isArray(executorsRes.executors) ? executorsRes.executors : []);
        setExecutorConfig(executorConfigRes.config || { codexCommand: "", claudeCommand: "" });
        setRecentRuns(Array.isArray(recentRunsRes.runs) ? recentRunsRes.runs : []);
        setProjectSummary(summaryRes && summaryRes.summary ? summaryRes.summary : null);

        // Fetch token via desktop IPC bridge (not HTTP) — internal only, no auth leakage
        const initialProject = initialProjectId
          ? nextProjects.find(function (project) { return project.id === initialProjectId; }) || null
          : null;
        // Fetch runtime/build identity info
        fetchJson("/api/desktop/runtime-info").then(function (r) {
          if (r && r.serverVersion) setRuntimeInfo(r);
        }).catch(function () { /* pre-dates this endpoint */ });

        setAIConfig(aiConfigRes.config || {
          providerPreset: "openai-gpt",
          provider: "openai-compatible",
          apiKey: "",
          baseUrl: "",
          model: "",
          codexBin: ""
        });
        setActiveProjectId(initialProjectId);
        setView(nextSession && nextSession.activeView ? nextSession.activeView : "home");

        if (initialProjectId) {
          await loadProjectTasks(initialProjectId, nextSession ? nextSession.activeTaskId : null);
          if (initialProject && initialProject.rootPath) {
            await syncProjectConnection(initialProjectId, initialProject.rootPath);
          }
        } else {
          resetTaskState();
          setFolderNotice({
            title: "Folder opened",
            message: "This folder does not have ScopeGuard metadata yet. Initialize ScopeGuard from this repository before starting a desktop task conversation."
          });
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to load desktop data.");
      } finally {
        setLoading(false);
      }
    }

    async function handleOpenProjectFolder() {
      setMessage("");
      setError("");

      const desktopApi = getDesktopApi();
      if (!desktopApi) {
        setMessage("Folder picker is available in the desktop app. In the browser prototype, start the board from the project folder you want to inspect.");
        return;
      }

      setBusy("open-folder");
      try {
        const result = await desktopApi.openProjectFolder();
        if (!result || result.canceled) {
          setMessage("Folder selection canceled.");
          return;
        }
        if (result.project) {
          setProjects(function (currentProjects) {
            const nextProjects = Array.isArray(currentProjects) ? currentProjects.slice() : [];
            const existingIndex = nextProjects.findIndex(function (project) {
              return project && project.rootPath === result.project.rootPath;
            });
            if (existingIndex >= 0) {
              nextProjects[existingIndex] = result.project;
              return nextProjects;
            }
            return [result.project].concat(nextProjects);
          });
          setActiveProjectId(result.project.id || null);
          setView("home");
          resetTaskState();
        }
        await boot();
        setMessage(result.folderPath ? "Project folder opened: " + result.folderPath : "Project folder opened.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to open project folder.");
      } finally {
        setBusy("");
      }
    }

    async function handleInitializeProject() {
      setMessage("");
      setError("");
      setBusy("initialize");

      try {
        await fetchJson("/api/desktop/initialize", { method: "POST" });
        await boot();
        setMessage("ScopeGuard initialized for this repository.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to initialize ScopeGuard.");
      } finally {
        setBusy("");
      }
    }

    async function handleInitializeGit() {
      setMessage("");
      setError("");
      setBusy("git-init");

      try {
        const result = await fetchJson("/api/desktop/git-init", { method: "POST" });
        if (result && result.project) {
          setProjects(function (currentProjects) {
            return (Array.isArray(currentProjects) ? currentProjects : []).map(function (project) {
              return project && activeProject && project.rootPath === activeProject.rootPath ? result.project : project;
            });
          });
          setActiveProjectId(result.project.id || null);
        }
        await boot(result && result.project ? result.project.id : null);
        setMessage(result && result.message ? result.message : "Git initialized for this folder.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to initialize git.");
      } finally {
        setBusy("");
      }
    }

    async function refreshProjectOverview() {
      try {
        var [summaryRes, runsRes] = await Promise.all([
          fetchJson("/api/desktop/summary").catch(function () { return { summary: null }; }),
          fetchJson("/api/desktop/runs/recent").catch(function () { return { runs: [] }; }),
        ]);
        setProjectSummary(summaryRes && summaryRes.summary ? summaryRes.summary : null);
        setRecentRuns(Array.isArray(runsRes.runs) ? runsRes.runs : []);
      } catch (err) {
        // silent refresh
      }
    }

    function clearRunPoll(intervalId) {
      var targetInterval = intervalId || pollIntervalRef.current;
      if (targetInterval) {
        clearInterval(targetInterval);
      }
      if (!intervalId || pollIntervalRef.current === intervalId) {
        pollIntervalRef.current = null;
      }
    }

    function resetTaskState() {
      setTasks([]);
      setProjectTaskSummary(null);
      setActiveTaskId(null);
      setTaskDetail(null);
      setTaskContext(null);
      setSelectedContextFilePath("");
      setSelectedContextFileContent("");
      setStreamingTaskReply("");
      setStreamingProjectReply("");
      setThread(null);
      setProjectThread(null);
      setActiveRun(null);
      setLastCompletedRun(null);
      setTaskRuns([]);
      activeTaskIdRef.current = null;
      clearRunPoll();
    }

    async function syncProjectConnection(projectId, projectRoot) {
      const rootPath = typeof projectRoot === "string" ? projectRoot : "";
      setExternalApiToken("");
      setConnectedClients([]);
      if (!projectId || !rootPath) return;

      let token = "";
      const desktopApi = getDesktopApi();
      if (desktopApi && typeof desktopApi.getExternalApiToken === "function") {
        try {
          const tokenResult = await desktopApi.getExternalApiToken(rootPath);
          if (tokenResult && tokenResult.ok && tokenResult.token) {
            token = tokenResult.token;
            setExternalApiToken(tokenResult.token);
          }
        } catch { /* token unavailable in this context */ }
      }

      try {
        await fetchJson("/api/desktop/projects/" + encodeURIComponent(projectId) + "/connect-artifact");
      } catch { /* artifact generation is best-effort */ }

      if (token) {
        try {
          const clientsRes = await fetchJson("/api/desktop/external/clients", {
            externalApiToken: token
          });
          if (clientsRes && Array.isArray(clientsRes.clients)) {
            setConnectedClients(clientsRes.clients);
          }
        } catch { /* clients unavailable */ }
      }
    }

    // ── Refresh connected clients for current active project ──
    async function refreshConnectedClients() {
      var rootPath = activeProject && activeProject.rootPath ? activeProject.rootPath : "";
      if (!activeProjectId || !rootPath) return;
      var desktopApi = getDesktopApi();
      var token = "";
      if (desktopApi && typeof desktopApi.getExternalApiToken === "function") {
        try {
          var tokenResult = await desktopApi.getExternalApiToken(rootPath);
          if (tokenResult && tokenResult.ok && tokenResult.token) token = tokenResult.token;
        } catch { /* ignore */ }
      }
      if (token) {
        try {
          var clientsRes = await fetchJson("/api/desktop/external/clients", { externalApiToken: token });
          if (clientsRes && Array.isArray(clientsRes.clients)) setConnectedClients(clientsRes.clients);
        } catch { /* ignore */ }
      }
    }

    async function loadProjectTasks(projectId, preferredTaskId) {
      const result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(projectId) + "/tasks");
      const nextTasks = Array.isArray(result.tasks) ? result.tasks : [];
      const nextTaskId = preferredTaskId && nextTasks.some(function (task) { return task.id === preferredTaskId; })
        ? preferredTaskId
        : null;

      setTasks(nextTasks);
      setProjectTaskSummary(result.summary || null);
      setActiveProjectId(projectId);
      activeProjectIdRef.current = projectId;

      if (nextTaskId) {
        await selectTask(projectId, nextTaskId, false);
        return;
      }

      setActiveTaskId(null);
      activeTaskIdRef.current = null;
      setTaskDetail(null);
      setTaskContext(null);
      setThread(null);
      setView("home");

      const projectRecord = projects.find(function (project) { return project.id === projectId; }) || null;
      if (projectRecord && projectRecord.rootPath) {
        await syncProjectConnection(projectId, projectRecord.rootPath);
      }
      const loadedProjectThread = await ensureProjectThread(projectId, projectRecord ? projectRecord.name : projectId);
      setProjectThread(loadedProjectThread);
    }

    async function refreshTaskList(projectId, preferredTaskId) {
      const result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(projectId) + "/tasks");
      const nextTasks = Array.isArray(result.tasks) ? result.tasks : [];
      setTasks(nextTasks);
      setProjectTaskSummary(result.summary || null);
      activeProjectIdRef.current = projectId;
      if (preferredTaskId && !nextTasks.some(function (task) { return task.id === preferredTaskId; })) {
        setActiveTaskId(null);
        activeTaskIdRef.current = null;
      }
    }

    async function selectProject(projectId) {
      setMessage("");
      setError("");
      setLoading(true);
      resetTaskState();

      try {
        var selectedProject = projects.find(function (project) { return project.id === projectId; }) || null;
        var desktopApi = getDesktopApi();
        if (
          selectedProject
          && desktopApi
          && typeof desktopApi.openKnownProject === "function"
          && (!activeProject || selectedProject.rootPath !== activeProject.rootPath)
        ) {
          await desktopApi.openKnownProject(selectedProject.rootPath);
          await boot(projectId);
          return;
        }

        await loadProjectTasks(projectId, null);
        var projectRecord = projects.find(function (project) { return project.id === projectId; }) || null;
        var loadedProjectThread = await ensureProjectThread(projectId, projectRecord ? projectRecord.name : projectId);
        setProjectThread(loadedProjectThread);
        await persistSession({
          activeProjectId: projectId,
          activeTaskId: null,
          activeThreadId: loadedProjectThread ? loadedProjectThread.id : null,
          activeView: "home",
          drawerState: currentDrawerState()
        });
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to open project.");
      } finally {
        setLoading(false);
      }
    }

    async function openSettings() {
      const nextSession = {
        activeProjectId: activeProjectId,
        activeTaskId: activeTaskId,
        activeThreadId: thread ? thread.id : (projectThread ? projectThread.id : null),
        activeView: "settings",
        drawerState: currentDrawerState()
      };
      setView("settings");
      await persistSession(nextSession);
    }

    async function saveSettings() {
      const normalizedConfig = {
        ...aiConfig,
        baseUrl: normalizeBaseUrl(aiConfig.baseUrl, aiConfig.provider)
      };
      const validationError = validateAIConfig(normalizedConfig);
      if (validationError) {
        setError(validationError);
        setMessage("");
        return;
      }

      setBusy("settings");
      setError("");
      setMessage("Saving...");

      var aiSaved = false;
      var execSaved = false;

      // Save AI config
      try {
        await fetchJson("/api/desktop/ai-config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: normalizedConfig })
        });
        const refreshed = await fetchJson("/api/desktop/ai-config");
        setAIConfig(refreshed.config || normalizedConfig);
        aiSaved = true;
      } catch (err) {
        setError("AI settings: " + (err && err.message ? err.message : "save failed."));
      }

      // Save executor config (independent of AI config result)
      try {
        await fetchJson("/api/desktop/executor-config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: executorConfig })
        });
        const refreshedExec = await fetchJson("/api/desktop/executor-config");
        setExecutorConfig(refreshedExec.config || executorConfig);
        execSaved = true;
      } catch (err) {
        var execMsg = "Executor settings: " + (err && err.message ? err.message : "save failed.");
        if (aiSaved) {
          setMessage("AI settings saved, but " + execMsg);
        } else {
          setError(execMsg);
        }
      }

      if (aiSaved && execSaved) {
        setMessage("Settings saved.");
      } else if (aiSaved && !execSaved) {
        // message already set in catch above
      }

      setBusy("");
    }

    async function selectTask(projectId, taskId, persist) {
      setMessage("");
      setError("");
      setLoading(true);
      clearRunPoll();

      try {
        const [detailRes, contextRes] = await Promise.all([
          fetchJson("/api/desktop/tasks/" + encodeURIComponent(taskId)),
          fetchJson("/api/desktop/tasks/" + encodeURIComponent(taskId) + "/context")
        ]);

        const nextThread = await ensureTaskThread(projectId, taskId, detailRes.task ? detailRes.task.title : taskId);

        setActiveProjectId(projectId);
        setActiveTaskId(taskId);
        activeProjectIdRef.current = projectId;
        activeTaskIdRef.current = taskId;
        setTaskDetail(detailRes.task || null);
            if (detailRes.task && detailRes.task.isDraft === true) { console.log("[scopeguard-web] task detail draft id=" + detailRes.task.id + " title=" + (detailRes.task.title || "")); }
        setTaskContext(contextRes.context || null);
        setSelectedContextFilePath("");
        setSelectedContextFileContent("");
        setThread(nextThread);
        setProjectThread(null);
        setActiveRun(null);
        setLastCompletedRun(null);
        setTaskRuns([]);
        setView("task");
        loadTaskRuns(taskId);
        // Refresh sidebar task list so dependency badges and statuses stay consistent with the detail page
        refreshTaskList(projectId, null).catch(function () {});

        if (persist !== false) {
          await persistSession({
            activeProjectId: projectId,
            activeTaskId: taskId,
            activeThreadId: nextThread ? nextThread.id : null,
            activeView: "task",
            drawerState: currentDrawerState()
          });
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to open task.");
      } finally {
        setLoading(false);
      }
    }

    async function ensureTaskThread(projectId, taskId, title) {
      const threadId = "task-" + taskId;

      try {
        const result = await fetchJson("/api/desktop/conversations/" + encodeURIComponent(threadId));
        return result.thread || null;
      } catch (err) {
        if (!String(err && err.message || "").includes("THREAD_NOT_FOUND")) {
          throw err;
        }
      }

      const created = await fetchJson("/api/desktop/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          kind: "task",
          taskId: taskId,
          title: title
        })
      });

      setMessage("Task conversation created.");
      return created.thread || null;
    }

    async function ensureProjectThread(projectId, title) {
      const threadId = "project-" + projectId;

      try {
        const result = await fetchJson("/api/desktop/conversations/" + encodeURIComponent(threadId));
        return result.thread || null;
      } catch (err) {
        if (!String(err && err.message || "").includes("THREAD_NOT_FOUND")) {
          throw err;
        }
      }

      const created = await fetchJson("/api/desktop/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: projectId,
          kind: "project",
          title: title
        })
      });

      return created.thread || null;
    }

    async function persistSession(nextSession) {
      setSession(nextSession);
      await fetchJson("/api/desktop/session", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: nextSession })
      });
    }

    function currentDrawerState() {
      return session && session.drawerState
        ? session.drawerState
        : { contextOpen: false, logsOpen: false };
    }

    async function toggleDrawer(panel) {
      const current = currentDrawerState();
      const nextDrawerState = {
        contextOpen: panel === "context" ? !current.contextOpen : false,
        logsOpen: panel === "logs" ? !current.logsOpen : false,
      };

      const nextSession = {
        activeProjectId: activeProjectId,
        activeTaskId: activeTaskId,
        activeThreadId: thread ? thread.id : (projectThread ? projectThread.id : null),
        activeView: view,
        drawerState: nextDrawerState,
      };

      setSession(nextSession);

      if (activeProjectId) {
        await fetchJson("/api/desktop/session", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: nextSession })
        });
      }
    }

    async function appendMessages(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      let resolved;

      setThread(function (currentThread) {
        if (!currentThread) {
          resolved = null;
          return currentThread;
        }

        resolved = {
          ...currentThread,
          updatedAt: new Date().toISOString(),
          messages: currentThread.messages.concat(messages)
        };

        return resolved;
      });

      if (!resolved) {
        return;
      }

      await fetchJson("/api/desktop/conversations/" + encodeURIComponent(resolved.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread: resolved })
      });
    }

    async function appendProjectMessages(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      let resolved;

      setProjectThread(function (currentThread) {
        if (!currentThread) {
          resolved = null;
          return currentThread;
        }

        resolved = {
          ...currentThread,
          updatedAt: new Date().toISOString(),
          messages: currentThread.messages.concat(messages)
        };

        return resolved;
      });

      if (!resolved) {
        return;
      }

      await fetchJson("/api/desktop/conversations/" + encodeURIComponent(resolved.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread: resolved })
      });
    }

    async function runTaskAction(action, options) {
      if (!activeTaskId || !taskDetail || !thread) {
        setMessage("Open a task conversation first.");
        return;
      }

      setBusy(action);
      setError("");
      setMessage("");

      try {
        const userText = options && options.userText ? options.userText : null;
        const outgoing = [];
        if (userText) {
          outgoing.push(buildUserMessage(userText));
        }

        if (outgoing.length > 0) {
          await appendMessages(outgoing);
        }

        if (action === "summary") {
          await appendMessages([buildScopeGuardLocalMessage("summary", summarizeTask(taskDetail, taskContext))]);
          return;
        }

        const endpoint = action === "handoff"
          ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/handoff"
          : action === "review"
            ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/review"
            : action === "approve"
              ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/approve"
              : action === "archive"
                ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/archive"
              : action === "refine"
                ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/refine"
                : action === "update-details"
                  ? "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/update-details"
                : action === "constraints"
                  ? null
                  : null;

        if (!endpoint) {
          if (action === "constraints") {
            await appendMessages([buildScopeGuardLocalMessage("summary", explainConstraints(taskDetail, taskContext))]);
          }
          return;
        }

        const result = await fetchJson(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options && options.body ? options.body : {})
        });

        const incoming = [];
        if (result.message) {
          incoming.push(result.message);
        }
        if (action === "handoff" && result.handoffText) {
          incoming.push(buildScopeGuardLocalMessage("summary", result.handoffText));
        }
        if (action === "review") {
          incoming.push(buildScopeGuardLocalMessage(
            "approval_request",
            "If the review looks good, you can approve this step here and keep the task moving toward merge readiness.",
            [
              {
                id: "a-local-approve",
                label: "Approve this review step",
                intent: "approve-step"
              }
            ]
          ));
        }
        if (incoming.length > 0) {
          await appendMessages(incoming);
        }

        if (action === "approve") { console.log("[scopeguard-web] approve request ok"); setMessage("Task approved."); await refreshCurrentTask(); refreshConnectedClients(); }

        if (action === "review") {
          await refreshCurrentTask();
        }

        if (action === "archive") {
          if (activeProjectId) {
            await loadProjectTasks(activeProjectId, null);
          }
          setView("home");
          setActiveTaskId(null);
          setTaskDetail(null);
          setTaskContext(null);
          setThread(null);
        }

        if (action === "refine") {
          if (result.task) {
            setTaskDetail(result.task);
          }
          if (result.context) {
            setTaskContext(result.context);
          }
          if (activeProjectId) {
            await refreshTaskList(activeProjectId, activeTaskId);
          }
          refreshConnectedClients();
        }

        if (action === "update-details") {
          if (result.task) {
            setTaskDetail(result.task);
          }
          if (result.context) {
            setTaskContext(result.context);
          }
          if (activeProjectId) {
            await refreshTaskList(activeProjectId, activeTaskId);
          }
        }

        setMessage(actionLabel(action) + " completed.");
      } catch (err) {
        setError(err && err.message ? err.message : ("Failed to run " + action + "."));
      } finally {
        setBusy("");
      }
    }

    async function refreshCurrentTask() {
      var targetProjectId = activeProjectIdRef.current || activeProjectId;
      var targetTaskId = activeTaskIdRef.current || activeTaskId;
      if (!targetProjectId || !targetTaskId) {
        return;
      }
      const [detailRes, contextRes] = await Promise.all([
        fetchJson("/api/desktop/tasks/" + encodeURIComponent(targetTaskId)),
        fetchJson("/api/desktop/tasks/" + encodeURIComponent(targetTaskId) + "/context")
      ]);
      if (activeTaskIdRef.current === targetTaskId || activeTaskId === targetTaskId) {
        setTaskDetail(detailRes.task || null);
        setTaskContext(contextRes.context || null);
      }
      await refreshTaskList(targetProjectId, targetTaskId);
    }

    async function handleMessageAction(action) {
      switch (action.intent) {
        case "review-task":
          await runTaskAction("review", { userText: "Review the draft and summarize the diff." });
          break;
        case "approve-step":
          await runTaskAction("approve", { userText: "Approve this step and continue." });
          break;
        case "generate-handoff":
          await runTaskAction("handoff", {
            userText: "Generate the executor handoff.",
            body: { target: action.payload && action.payload.target ? action.payload.target : "codex" }
          });
          break;
        case "refine-draft":
          await runTaskAction("refine", { userText: "Refine this draft into a formal task." });
          break;
        case "summarize-task":
          await runTaskAction("summary", { userText: "Summarize the current task state." });
          break;
        case "explain-route":
          await runTaskAction("summary", { userText: "Explain the current plan." });
          break;
        case "explain-constraints":
          await runTaskAction("constraints", { userText: "Explain the current constraints." });
          break;
        case "set-allowed-files":
          setDraftInput("");
          break;
        case "set-acceptance-criteria":
          setDraftInput("");
          break;
        case "set-commands":
          setDraftInput("");
          break;
        default:
          break;
      }
    }

    async function handleSend() {
      if (busy) {
        return;
      }

      const text = String(draftInput || "").trim();
      if (!text) {
        return;
      }
      if (!activeTaskId) {
        setMessage("Open a task first.");
        return;
      }

      setDraftInput("");

      // If task has an assignedExecutor, route directly to executor run
      // with the user's text as the follow-up message.
      if (taskDetail && taskDetail.assignedExecutor) {
        await appendMessages([buildUserMessage(text)]);
        setMessage("Starting executor: " + taskDetail.assignedExecutor + "...");
        await handleTaskRun(taskDetail.assignedExecutor, text);
        return;
      }

      // Fallback: no assigned executor — use ScopeGuard LLM for discussion.
      await appendMessages([buildUserMessage(text)]);

      setBusy("summary");
      setError("");
      setMessage("");
      setStreamingTaskReply("Thinking...");

      try {
        const result = await streamAssistant("/api/desktop/assistant", {
          scope: "task",
          taskId: activeTaskId,
          userText: text,
          stream: true
        }, function () {
          setStreamingTaskReply(function (current) { return current || "Thinking..."; });
        });

        const finalTaskMessage = result.message || (result.reply ? buildScopeGuardLocalMessage("summary", result.reply) : null);
        if (finalTaskMessage) {
          await appendMessages([finalTaskMessage]);
        }
        if (result.task) {
          setTaskDetail(result.task);
        }
        if (result.context) {
          setTaskContext(result.context);
        }
        if (activeProjectId) {
          await refreshTaskList(activeProjectId, activeTaskId);
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to continue the task conversation.");
      } finally {
        setStreamingTaskReply("");
        setBusy("");
      }
    }

    async function handleTaskRun(executorId, userText) {
      if (!activeTaskId) return;
      setError("");
      setMessage("");

      try {
        var result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ executorId: executorId, userText: userText || "" })
        });

        if (result.run) {
          var runTaskId = result.run.taskId;
          // If the draft was promoted, refresh task detail and task list
          if (result.promotedFromDraft) {
            if (activeProjectId && runTaskId) {
              await refreshTaskList(activeProjectId, runTaskId);
              await selectTask(activeProjectId, runTaskId, true);
            }
          }
          setActiveRun(result.run);
          pollRunStatus(result.run.runId, runTaskId);
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to start executor.");
      }
    }

    async function handleQueueAssignment() {
      if (!activeTaskId) {
        console.log("[scopeguard-web] handleQueueAssignment: no activeTaskId");
        return;
      }
      setError("");
      setMessage("Queueing task for connected agent...");
      console.log("[scopeguard-web] handleQueueAssignment: taskId=" + activeTaskId);
      try {
        var result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/queue-assignment", {
          method: "POST"
        });
        console.log("[scopeguard-web] handleQueueAssignment: response ok=" + result.ok + " assignmentId=" + (result.assignment ? result.assignment.assignmentId : "none"));
        if (result && result.ok && result.assignment) {
          setMessage("Task queued for connected agent.");
          if (activeProjectId && activeTaskId) {
            await selectTask(activeProjectId, activeTaskId, true);
          }
        } else {
          var errMsg = result && result.message ? result.message : "Failed to queue task.";
          console.log("[scopeguard-web] handleQueueAssignment: rejected: " + errMsg);
          setError(errMsg);
        }
      } catch (err) {
        var errMsg = err && err.message ? err.message : "Failed to queue task.";
        console.log("[scopeguard-web] handleQueueAssignment: error: " + errMsg);
        setError(errMsg);
      }
    }

    async function handleCancelAssignment() {
      if (!activeTaskId || !taskDetail) {
        console.log("[scopeguard-web] handleCancelAssignment: no activeTaskId or taskDetail");
        return;
      }
      var execAssignId = taskDetail.activeExecutionAssignmentId;
      if (!execAssignId) {
        setError("No active execution assignment to cancel.");
        return;
      }
      setError("");
      setMessage("Canceling dispatch...");
      console.log("[scopeguard-web] handleCancelAssignment: taskId=" + activeTaskId + " assignmentId=" + execAssignId);
      try {
        var result = await fetchJson("/api/desktop/external/pending/" + encodeURIComponent(execAssignId) + "/cancel", {
          method: "POST"
        });
        if (result && result.ok) {
          setMessage("Dispatch canceled. Task is ready to queue again.");
          // Refresh task detail and sidebar task list so status badges update
          if (activeProjectId && activeTaskId) {
            await selectTask(activeProjectId, activeTaskId, true);
          }
          if (activeProjectId) {
            loadProjectTasks(activeProjectId).catch(function (e) {
              console.log("[scopeguard-web] handleCancelAssignment: loadProjectTasks error: " + (e && e.message || e));
            });
          }
        } else {
          var errMsg = result && result.message ? result.message : "Cancel failed.";
          console.log("[scopeguard-web] handleCancelAssignment: rejected: " + errMsg);
          setError(errMsg);
        }
      } catch (err) {
        var errMsg = err && err.message ? err.message : "Cancel failed.";
        console.log("[scopeguard-web] handleCancelAssignment: error: " + errMsg);
        setError(errMsg);
      }
    }

    async function handleBatchQueue() {
      if (!activeProjectId) {
        setError("No active project.");
        return;
      }
      setError("");
      setMessage("Queueing ready tasks...");
      try {
        var result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProjectId) + "/queue-ready", {
          method: "POST"
        });
        if (result && result.ok) {
          var parts = [];
          if (result.queued && result.queued.length > 0) {
            parts.push("Queued " + String(result.queued.length) + " task(s).");
          }
          if (result.skipped && result.skipped.length > 0) {
            var skipSummary = result.skipped.map(function (s) { return s.message; }).join("; ");
            parts.push("Skipped " + String(result.skipped.length) + " (" + skipSummary + ").");
          }
          setMessage(parts.length > 0 ? parts.join(" ") : "No tasks were eligible to queue.");
          if (activeProjectId) {
            await refreshTaskList(activeProjectId, null);
          }
        } else {
          var errMsg = result && result.message ? result.message : "Batch queue failed.";
          setError(errMsg);
        }
      } catch (err) {
        var errMsg = err && err.message ? err.message : "Failed to queue tasks.";
        setError(errMsg);
      }
    }

    async function handleBatchCancel() {
      if (!activeProjectId) {
        setError("No active project.");
        return;
      }
      setError("");
      setMessage("Canceling active dispatches...");
      try {
        var result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProjectId) + "/cancel-dispatches", {
          method: "POST"
        });
        if (result && result.ok) {
          var parts = [];
          if (result.canceled && result.canceled.length > 0) {
            parts.push("Canceled " + String(result.canceled.length) + " active dispatch(es).");
          }
          if (result.skipped && result.skipped.length > 0) {
            parts.push("Skipped " + String(result.skipped.length) + " (" + result.skipped.map(function (s) { return s.message; }).join("; ") + ").");
          }
          setMessage(parts.length > 0 ? parts.join(" ") : "No active dispatches to cancel.");
          if (activeProjectId) {
            await refreshTaskList(activeProjectId, null);
          }
        } else {
          var errMsg = result && result.message ? result.message : "Batch cancel failed.";
          setError(errMsg);
        }
      } catch (err) {
        var errMsg = err && err.message ? err.message : "Failed to cancel dispatches.";
        setError(errMsg);
      }
    }

    async function handleProjectPlan(textOverride, options) {
      var text = String(textOverride != null ? textOverride : homeDraftInput || "").trim();
      var config = options || {};
      if (!text) return;
      if (!activeProject) return;

      setPlanningBusy(true);
      if (!config.keepDraftValue) {
        setHomeDraftInput("");
      }
      setError("");
      setMessage("Generating a plan proposal...");

      if (!config.skipAppendUserMessage) {
        var ensuredProjectThread = projectThread;
        if (!ensuredProjectThread) {
          ensuredProjectThread = await ensureProjectThread(activeProject.id, activeProject.name || activeProject.id);
          setProjectThread(ensuredProjectThread);
        }
        await appendProjectMessages([buildUserMessage(text)]);
      }

      try {
        if (config.discardExistingProposal && planningTasks && planningTasks.length > 0) {
          await deletePersistedProposalItems(planningTasks);
          setPlanningTasks([]);
        }
        var result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userGoal: text })
        });

        if (result.tasks && result.tasks.length > 0) {
          setPlanningTasks(result.tasks);
          // Auto-normalize plan via server
          try {
            var normPayload = { tasks: result.tasks.map(function (pt) { return { title: pt.title, goal: pt.goal || pt.title, allowedFiles: pt.allowedFiles || [], acceptanceCriteria: pt.acceptanceCriteria || [], commands: pt.commands || [], preferredExecutor: pt.preferredExecutor || "claude-cli", assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli", dependsOn: pt.dependsOn || [], parallelizable: pt.parallelizable || false, priority: pt.priority || "medium" }; }) };
            var normResult = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/normalize-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(normPayload) });
            if (normResult.ok && Array.isArray(normResult.tasks)) {
              var normalizedTasks = normResult.tasks.map(function (task, idx) { var orig = result.tasks[idx] || {}; return Object.assign({}, task, { id: orig.id || "IMPORTED-" + Date.now() + "-" + String(idx) }); });
              setPlanningTasks(normalizedTasks);
            }
          } catch (normErr) { /* non-fatal */ }
          var sourceLabel = result.planSource === "local-llm"
            ? "local LLM"
            : result.planSource === "claude-cli"
              ? "Claude CLI fallback"
              : "fallback";
          var summaryText = "Plan proposal created with " + result.tasks.length + " task(s) via " + sourceLabel + ". Review, edit, then commit to formal tasks.";
          if (result.planSource === "fallback") {
            summaryText = "Planner returned unstructured output. Created a single proposal item for review.";
          }
          setMessage(summaryText);
          await appendProjectMessages([buildScopeGuardLocalMessage("summary", summaryText)]);
          void refreshProjectOverview();
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Planning failed.");
        await appendProjectMessages([buildScopeGuardLocalMessage("summary", "Planning failed: " + (err && err.message ? err.message : "unknown error"))]);
      } finally {
        setPlanningBusy(false);
      }
    }

    async function deletePersistedProposalItems(items) {
      var targets = (items || []).filter(function (item) {
        return item && item.id && !String(item.id).startsWith("IMPORTED-");
      });
      for (var i = 0; i < targets.length; i += 1) {
        try {
          await fetchJson("/api/desktop/tasks/draft/" + encodeURIComponent(targets[i].id), { method: "DELETE" });
        } catch (err) {
          var msg = err && err.message ? err.message : "";
          if (!msg.includes("TASK_NOT_FOUND")) throw err;
        }
      }
    }

    async function handleTestCLI(executorId) {
      setMessage("");
      setError("");
      try {
        var result = await fetchJson("/api/desktop/executors/" + encodeURIComponent(executorId) + "/test", {
          method: "POST"
        });
        if (result.test) {
          setCliTestResults(function (prev) {
            var next = {};
            for (var k in prev) { next[k] = prev[k]; }
            next[executorId] = Object.assign({}, result.test, result._debug ? { _debug: result._debug } : {});
            return next;
          });
          setMessage(result.test.ok ? (result.test.version || "CLI available") : result.test.message);
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Test failed.");
      }
    }

    async function handleOpenCLI(executorId) {
      setMessage("");
      setError("");
      try {
        var result = await fetchJson("/api/desktop/executors/" + encodeURIComponent(executorId) + "/open", {
          method: "POST"
        });
        setMessage(result.message || "CLI launched.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to launch CLI.");
      }
    }

    async function handleCopyHandoff() {
      if (!activeTaskId) return;
      setError("");
      setHandoffPreviewText("");
      try {
        var result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/handoff", {
          externalApiToken: externalApiToken
        });
        if (result.handoff) {
          var text = JSON.stringify(result.handoff, null, 2);
          try {
            await navigator.clipboard.writeText(text);
            setMessage("Handoff copied to clipboard.");
          } catch (clipErr) {
            setError("Clipboard access denied. Showing handoff below for manual copy.");
            setHandoffPreviewText(text);
          }
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to fetch handoff.");
      }
    }

    // ── Project-local MCP env block ──
    function buildProjectMCPEnv(projectRoot, token) {
      var baseUrl = "http://127.0.0.1:" + (typeof SCOPEGUARD_PORT !== "undefined" ? String(SCOPEGUARD_PORT) : "3737");
      var rootPath = String(projectRoot || "").replace(/\\/g, "/");
      return [
        "# ScopeGuard project-local MCP bridge configuration",
        "# Generated for: " + rootPath,
        "",
        "SCOPEGUARD_BASE_URL=" + baseUrl,
        "SCOPEGUARD_TOKEN=" + (token || "<project-token>"),
        "SCOPEGUARD_EXECUTOR_ID=claude-cli",
        "",
        "# Usage: pass these to the MCP bridge script",
        "#   node scripts/scopeguard-mcp-bridge.js",
        "# or add to Claude Desktop MCP config (.json):",
        '#   { "command": "node", "args": ["scripts/scopeguard-mcp-bridge.js"], "env": {',
        '#       "SCOPEGUARD_BASE_URL": "' + baseUrl + '",',
        '#       "SCOPEGUARD_TOKEN": "' + (token || "<project-token>") + '",',
        '#       "SCOPEGUARD_EXECUTOR_ID": "claude-cli"',
        "#     }",
        "#   }",
      ].join("\n");
    }

    // ── Project-local MCP JSON snippet for Claude Desktop config ──
    function buildProjectMCPJsonSnippet(projectRoot, token) {
      var baseUrl = "http://127.0.0.1:" + (typeof SCOPEGUARD_PORT !== "undefined" ? String(SCOPEGUARD_PORT) : "3737");
      var rootPath = String(projectRoot || "").replace(/\\/g, "/");
      var bridgePath = rootPath ? rootPath + "/scripts/scopeguard-mcp-bridge.js" : "scripts/scopeguard-mcp-bridge.js";
      return JSON.stringify({
        "scopeguard-connect": {
          command: "node",
          args: [bridgePath],
          env: {
            SCOPEGUARD_BASE_URL: baseUrl,
            SCOPEGUARD_TOKEN: token || "<project-token>",
            SCOPEGUARD_EXECUTOR_ID: "claude-cli",
          },
          description: "ScopeGuard MCP bridge for " + rootPath.replace(/^.*[\\/]/, ""),
        }
      }, null, 2);
    }

    function buildQuickConnectText() {
      var baseUrl = "http://localhost:<scopeguard-port>";
      return [
        "# ScopeGuard External Executor Quick Connect",
        "Protocol: scopeguard-external-v1",
        "",
        "## Authentication",
        "All external API endpoints require a Bearer token.",
        "Header: Authorization: Bearer <token>",
        "Get your token from: Settings -> External Executor Integration -> Copy",
        "",
        "## Quick connect your agent",
        "1. Open your agent (Claude CLI, Codex CLI, or custom MCP bridge)",
        "2. Initialize a session:",
        "  POST " + baseUrl + "/api/desktop/external/initialize",
        "  Header: Authorization: Bearer <token>",
        "  Body: { \"clientName\": \"my-agent\", \"executorId\": \"claude-cli\", \"mode\": \"connected\" }",
        "3. Once connected, ScopeGuard can automatically route matching tasks",
        "   to this agent based on the task's assigned executor.",
        "",
        "## Codex CLI (MCP-style)",
        "Initialize with executorId \"codex-cli\":",
        "",
        "  Server URL:  " + baseUrl,
        "  Token:       <from Settings>",
        "  Mode:        connected",
        "",
        "Use the sample bridge to test:",
        "",
        "  PowerShell:",
        "    node scripts/external-bridge-example.js --mode exec --executorId codex-cli --taskId <id> --token <token>",
        "",
        "  Bash:",
        "    node scripts/external-bridge-example.js \\",
        "      --mode exec --executorId codex-cli --taskId <id> --token $SCOPEGUARD_TOKEN",
        "",
        "## Claude CLI (Connected Executor)",
        "Initialize with executorId \"claude-cli\":",
        "",
        "  PowerShell:",
        "    node scripts/external-bridge-example.js --mode exec --executorId claude-cli --taskId <id> --token <token>",
        "",
        "  Bash:",
        "    node scripts/external-bridge-example.js \\",
        "      --mode exec --executorId claude-cli --taskId <id> --token $SCOPEGUARD_TOKEN",
        "",
        "Once connected and initialized, tasks with assignedExecutor matching",
        "your agent will show \"Dispatch ready\" in the task view.",
        "",
        "## Companion Worker (Optional Automation)",
        "For semi-automatic execution, run the reference bridge in pull mode:",
        "",
        "  PowerShell:",
        "    node scripts/external-bridge-example.js --mode pull --token <token>",
        "",
        "  Bash:",
        "    node scripts/external-bridge-example.js \\",
        "      --mode pull --token $SCOPEGUARD_TOKEN",
        "",
        "This starts a long-running companion process that continuously polls for",
        "queued tasks matching your configured executor, claims and executes them.",
        "This is optional — standard MCP integration does not require it.",
        "",
        "## Generic MCP Bridge + Skill Workflow",
        "For IDE/host integration (Claude Desktop, Codex, OpenCode):",
        "  scripts/scopeguard-mcp-bridge.js",
        "Run as a stdio MCP server. Configure via env vars: SCOPEGUARD_BASE_URL,",
        "SCOPEGUARD_TOKEN, SCOPEGUARD_EXECUTOR_ID.",
        "The bridge exposes tools and prompts for a structured task workflow:",
        "  scopeguard_status — check connectivity",
        "  scopeguard_list_pending — list queued tasks",
        "  scopeguard_claim_assignment — claim one task",
        "  scopeguard_finish_assignment — report results",
        "A skill file (.claude/commands/scopeguard-run.md) documents the full workflow.",
        "Hosts can trigger one-shot execution via the scopeguard_run_once prompt.",
        "",
        "## Manual fallback",
        "If no connected agent is available, use:",
        "  - Copy handoff -> run with your CLI -> Import result",
        "",
        "  PowerShell:",
        "    node scripts/external-bridge-example.js --mode exec --executorId claude-cli --taskId <id> --token <token>",
        "",
        "  Bash:",
        "    node scripts/external-bridge-example.js \\",
        "      --mode exec --executorId claude-cli --taskId <id> --token $SCOPEGUARD_TOKEN",
        "",
        "Reference script: scripts/external-bridge-example.js",
        "Run with --help for all options.",
      ].join("\n");
    }

    function buildAdvancedGuideText() {
      var baseUrl = "http://localhost:<scopeguard-port>";
      return [
        "## Protocol details (7-step flow)",
        "",
        "### Step 1: Discover capabilities",
        "GET " + baseUrl + "/api/desktop/external/discovery",
        "Header: Authorization: Bearer <token>",
        "Returns server capabilities, available endpoints, and protocol version.",
        "",
        "### Step 2: Initialize a session (recommended)",
        "POST " + baseUrl + "/api/desktop/external/initialize",
        "Header: Authorization: Bearer <token>",
        "Body: { \"clientName\": \"my-mcp-bridge\", \"clientVersion\": \"1.0.0\", \"protocolVersion\": \"scopeguard-external-v1\", \"executorId\": \"claude-cli\" }",
        "Response: { ok: true, sessionId: \"uuid\", acceptedProtocolVersion: \"...\", serverCapabilities: {...}, heartbeatIntervalMs: 30000 }",
        "Include the returned sessionId in all subsequent calls.",
        "",
        "### Step 3: Get task handoff (recommended)",
        "GET " + baseUrl + "/api/desktop/tasks/{taskId}/handoff",
        "Header: Authorization: Bearer <token>",
        "Returns DesktopTaskHandoff: goal, allowedFiles, forbiddenFiles, acceptanceCriteria, commands, projectMemory, recentContext.",
        "",
        "### Step 4: Register a connected run",
        "POST " + baseUrl + "/api/desktop/tasks/{taskId}/external-run/start",
        "Header: Authorization: Bearer <token>",
        "Body: { \"executorId\": \"claude-cli\", \"externalSessionId\": \"unique-external-session-id\", \"sessionId\": \"uuid-from-step2\" }",
        "Response: DesktopTaskRunRecord { runId, status: \"starting\" }",
        "Returns 409 if task already has an active run.",
        "",
        "### Step 5: Execute task",
        "Use the handoff data (Step 3) to drive your executor (Codex CLI, Claude CLI, custom MCP bridge).",
        "The sample bridge (scripts/external-bridge-example.js) supports two modes:",
        "  --mode simulate  (fake execution, no CLI required)",
        "  --mode exec       (spawns real Claude/Codex CLI with task handoff prompt)",
        "",
        "### Step 6: Report results",
        "POST " + baseUrl + "/api/desktop/tasks/{taskId}/external-run/finish",
        "Header: Authorization: Bearer <token>",
        "Body: { \"executorId\": \"claude-cli\", \"externalSessionId\": \"unique-external-session-id\", \"success\": true, \"stdout\": \"...\", \"stderr\": \"...\", \"resultSummary\": \"...\", \"changedFiles\": [\"path/file\"], \"exitCode\": 0, \"sessionId\": \"uuid-from-step2\" }",
        "This advances task status and writes latestRunResult + latestReviewSummary.",
        "",
        "### Step 7: Heartbeat (recommended every 30s)",
        "POST " + baseUrl + "/api/desktop/external/ping",
        "Header: Authorization: Bearer <token>",
        "Body: { \"sessionId\": \"uuid-from-step2\" }",
        "Response: { ok: true, serverTime: \"...\", sessionId: \"uuid\", message: \"pong\" }",
        "",
        "## Optional: Submit structured review",
        "POST " + baseUrl + "/api/desktop/tasks/{taskId}/external-review",
        "Header: Authorization: Bearer <token>",
        "Body: { \"executorId\": \"claude-cli\", \"externalSessionId\": \"unique-external-session-id\", \"status\": \"ready_for_review\", \"suggestion\": \"Looks good.\", \"sessionId\": \"uuid-from-step2\" }",
        "",
        "## Server Capabilities",
        "taskHandoff: true | externalRunReporting: true | reviewReporting: true | sessionInit: true | heartbeat: true | connectedExecutor: true | tokenAuth: true",
        "",
        "## Windows compatibility",
        "The reference bridge exec mode does not support .cmd or .bat executables.",
        "On Windows, npm global installs typically create .cmd shims, so bare commands",
        "(claude/codex) may not work in exec mode. Use a direct .exe path or --mode simulate.",
        "",
        "## Types",
        "DesktopExecutorId: \"codex-cli\" | \"claude-cli\"",
        "DesktopTaskRunStatus: \"starting\" | \"running\" | \"succeeded\" | \"failed\"",
        "DesktopLaunchMode: \"managed\" | \"connected\"",
        "",
        "## Session lifecycle",
        "Sessions are stored in .scopeguard/config/external-sessions/ (one JSON file per session).",
        "The ping endpoint (Step 7) and all external-run APIs update lastSeenAt to keep a session alive.",
        "Sessions persist indefinitely until manually removed.",
      ].join("\n");
    }

    async function handleCopyConnectionGuide() {
      setError("");
      try {
        var text = buildQuickConnectText();
        try {
          await navigator.clipboard.writeText(text);
          setMessage("Connection guide copied to clipboard.");
        } catch (clipErr) {
          setError("Clipboard access denied. Connection guide text:\n" + text);
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to build connection guide.");
      }
    }

    async function handleImportExternalResult() {
      if (!activeTaskId) return;
      setError("");
      setMessage("Open the external executor, paste the task handoff, then submit the result back here.");

      var importedSummary = prompt("Paste the result JSON from the external executor:");
      if (!importedSummary) return;

      var parsed = null;
      try { parsed = JSON.parse(importedSummary); } catch (e) {
        setError("Invalid JSON. Make sure to paste the full result object.");
        return;
      }

      try {
        var executorId = parsed.executorId || "codex-cli";
        var externalSessionId = parsed.externalSessionId || parsed.sessionId || "manual-" + Date.now();
        var finishPayload = {
          executorId: executorId,
          externalSessionId: externalSessionId,
          success: parsed.success === false ? false : true,
          stdout: parsed.stdout || "",
          stderr: parsed.stderr || "",
          resultSummary: parsed.resultSummary || "Result imported manually.",
          changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
          exitCode: parsed.exitCode !== undefined ? parsed.exitCode : (parsed.success === false ? 1 : 0),
        };
        var finishEndpoint = "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/external-run/finish";
        var startEndpoint = "/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/external-run/start";
        var finishExternalRun = function () {
          return fetchJson(finishEndpoint, {
            externalApiToken: externalApiToken,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(finishPayload)
          });
        };
        var result;
        try {
          result = await finishExternalRun();
        } catch (finishErr) {
          if (!String(finishErr && finishErr.message || "").includes("RUN_NOT_FOUND")) {
            throw finishErr;
          }
          await fetchJson(startEndpoint, {
            externalApiToken: externalApiToken,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              executorId: executorId,
              externalSessionId: externalSessionId
            })
          });
          result = await finishExternalRun();
        }
        if (result.ok) {
          setMessage("External result imported and task status updated.");
          await loadTaskRuns(activeTaskId);
          await refreshCurrentTask();
          void refreshProjectOverview();
        }
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to import result.");
      }
    }

    function pollRunStatus(runId, taskId) {
      var targetTaskId = taskId || activeTaskIdRef.current || activeTaskId;
      if (!targetTaskId || !runId) return;

      clearRunPoll();

      var intervalId = setInterval(async function () {
        try {
          var result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(targetTaskId) + "/runs/" + encodeURIComponent(runId));
          if (result.run) {
            if (activeTaskIdRef.current === targetTaskId || activeTaskId === targetTaskId) {
              setActiveRun(result.run);
            }
            if (result.run.status === "succeeded" || result.run.status === "failed") {
              clearRunPoll(intervalId);
              if (activeTaskIdRef.current === targetTaskId || activeTaskId === targetTaskId) {
                setLastCompletedRun(result.run);
                await loadTaskRuns(targetTaskId);
                await refreshCurrentTask();
              }
              void refreshProjectOverview();
            }
          }
        } catch (err) {
          clearRunPoll(intervalId);
        }
      }, 800);
      pollIntervalRef.current = intervalId;
    }

    async function loadTaskRuns(taskId) {
      var targetTaskId = taskId || activeTaskId;
      if (!targetTaskId) return;
      try {
        var result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(targetTaskId) + "/runs");
        var runs = Array.isArray(result.runs) ? result.runs : [];
        setTaskRuns(runs);

        // Restore active run if there's an in-progress one
        var active = null;
        for (var i = 0; i < runs.length; i++) {
          if (runs[i].status === "starting" || runs[i].status === "running") {
            active = runs[i];
            break;
          }
        }

        if (active) {
          setActiveRun(active);
          setLastCompletedRun(null);
          // Resume polling for the active run
          pollRunStatus(active.runId, targetTaskId);
        } else {
          setActiveRun(null);
          // Restore latest completed run for result display
          var lastCompleted = null;
          for (var i = 0; i < runs.length; i++) {
            if (runs[i].status === "succeeded" || runs[i].status === "failed") {
              lastCompleted = runs[i];
              break;
            }
          }
          setLastCompletedRun(lastCompleted);
        }
      } catch (err) {
        // runs not available yet
      }
    }

    async function openContextFilePreview(path) {
      if (!path) {
        return;
      }

      setSelectedContextFilePath(path);
      setSelectedContextFileLoading(true);
      setError("");

      try {
        const result = await fetchJson("/api/desktop/file-preview?path=" + encodeURIComponent(path));
        const file = result.file || {};
        setSelectedContextFileContent(file.content || "");
      } catch (err) {
        setSelectedContextFileContent("");
        setError(err && err.message ? err.message : "Failed to load file preview.");
      } finally {
        setSelectedContextFileLoading(false);
      }
    }

    async function handleHomeSend(textOverride) {
      if (busy) {
        return;
      }

      const text = String(textOverride != null ? textOverride : homeDraftInput || "").trim();
      if (!text) {
        return;
      }
      if (!activeProject) {
        setError("Open a project first.");
        return;
      }

      let ensuredProjectThread = projectThread;
      if (!ensuredProjectThread) {
        ensuredProjectThread = await ensureProjectThread(activeProject.id, activeProject.name || activeProject.id);
        setProjectThread(ensuredProjectThread);
      }
      if (!ensuredProjectThread) {
        setError("Project conversation is not ready yet. Please try once more.");
        return;
      }
      if (!activeProject.isTrusted) {
        setMessage("Trust this workspace first so ScopeGuard can read project files and answer with real context.");
        return;
      }

      // ── Slash commands (explicit, highest priority) ──
      if (text.startsWith("/plan ")) {
        const planGoal = text.slice(6).trim();
        if (!planGoal) {
          setError("Usage: /plan <goal>. Example: /plan create the README and examples structure");
          return;
        }
        if (textOverride == null) {
          setHomeDraftInput("");
        }
        await handleProjectPlan(planGoal, { skipAppendUserMessage: false, keepDraftValue: true });
        return;
      }

      if (text === "/plan" || text === "/plan ") {
        setError("Usage: /plan <goal>. Example: /plan create the README and examples structure");
        return;
      }

      if (text === "/help" || text === "/?") {
        var slashSummary = [
          "Available commands:",
          "",
          "  /plan <goal>     Turn a goal into structured tasks via Claude planning.",
          "                   Example: /plan create README and examples",
          "",
          "  /help            Show this help message.",
          "",
          "Execution routes (from highest to lowest priority):",
          "  1. Connected Agents / MCP — the standard path.",
          "     Queue tasks for connected agents. Works with any MCP host.",
          "  2. Companion Worker (optional) — semi-automatic execution.",
          "     node scripts/external-bridge-example.js --mode pull",
          "  3. Local CLI Launch (experimental/fallback) — direct CLI spawn.",
          "",
          "Tip: Click the + button for planning and external executor tools."
        ].join("\n");
        await appendProjectMessages([buildUserMessage(text)]);
        await appendProjectMessages([buildScopeGuardLocalMessage("summary", slashSummary)]);
        if (textOverride == null) {
          setHomeDraftInput("");
        }
        setBusy("");
        return;
      }

      // ── Structured plan detection (paste JSON or Markdown task list) ──
      if (!text.startsWith("/")) {
        var structuredTasks = tryParseStructuredPlan(text);
        if (structuredTasks && structuredTasks.length > 0) {
          if (textOverride == null) {
            setHomeDraftInput("");
          }
          setPlanningBusy(true);
          setMessage("Importing " + structuredTasks.length + " task(s) from plan input...");
          setPlanningTasks(structuredTasks);
          // Auto-normalize via server
          try {
            var normPayload = {
              tasks: structuredTasks.map(function (pt) {
                return {
                  title: pt.title,
                  goal: pt.goal || pt.title,
                  allowedFiles: pt.allowedFiles || [],
                  acceptanceCriteria: pt.acceptanceCriteria || [],
                  commands: pt.commands || [],
                  preferredExecutor: pt.preferredExecutor || "claude-cli",
                  assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli",
                  dependsOn: pt.dependsOn || [],
                  parallelizable: pt.parallelizable || false,
                  priority: pt.priority || "medium"
                };
              })
            };
            var normResult = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/normalize-plan", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(normPayload)
            });
            if (normResult.ok && Array.isArray(normResult.tasks)) {
              var normalizedTasks = normResult.tasks.map(function (task, idx) {
                var orig = structuredTasks[idx] || {};
                return Object.assign({}, task, {
                  id: orig.id || "IMPORTED-" + Date.now() + "-" + String(idx)
                });
              });
              setPlanningTasks(normalizedTasks);
              setMessage("Imported " + normalizedTasks.length + " task(s)." + (normResult.readiness && normResult.readiness.summary ? " " + normResult.readiness.summary : ""));
            }
          } catch (normErr) {
            setMessage("Imported " + structuredTasks.length + " task(s). Click any task to edit details.");
          } finally {
            setPlanningBusy(false);
          }
          return;
        }
      }

      // ── Intent detection (fallback) ──
      const projectIntent = detectProjectIntentV2(text);
      if (textOverride == null) {
        setHomeDraftInput("");
      }
      setBusy("home");
      setError("");
      setMessage("");
      try {
        if (projectIntent.type === "start-task-conversation") {
          await appendProjectMessages([buildUserMessage(text)]);
          await startTaskConversationFromProjectGoal(text);
          return;
        }

        if (projectIntent.type === "plan-project" && activeProject.isInitialized) {
          await handleProjectPlan(text, { skipAppendUserMessage: false, keepDraftValue: true });
          return;
        }

        await appendProjectMessages([buildUserMessage(text)]);
        setStreamingProjectReply("Thinking...");
        const result = await streamAssistant("/api/desktop/assistant", {
          scope: "project",
          projectId: activeProject.id,
          userText: text,
          stream: true
        }, function () {
          setStreamingProjectReply(function (current) { return current || "Thinking..."; });
        });

        const finalProjectMessage = result.message || (result.reply ? buildScopeGuardLocalMessage("summary", result.reply) : null);
        if (finalProjectMessage) {
          await appendProjectMessages([finalProjectMessage]);
        }
        if (result.openTaskId && activeProjectId) {
          await loadProjectTasks(activeProjectId, result.openTaskId);
          await selectTask(activeProjectId, result.openTaskId, true);
        }
      } catch (err) {
        const errorMessage = err && err.message ? err.message : "Failed to continue the project conversation.";
        if (String(errorMessage).includes("LLM_NOT_CONFIGURED")) {
          await appendProjectMessages([buildScopeGuardLocalMessage("summary", "LLM is not configured yet. Go to Settings to set up a provider, then come back and I'll be able to respond.")]);
          return;
        }
        setError(errorMessage);
      } finally {
        setStreamingProjectReply("");
        setBusy("");
      }
    }

    async function handleProjectRenameSave() {
      const title = String(projectRenameDraft || "").trim();
      if (!activeProject) {
        setMessage("Open a project first.");
        return;
      }
      if (!title) {
        setMessage("Enter a project title first.");
        return;
      }

      setBusy("rename-project");
      setError("");
      setMessage("");

      try {
        const result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title })
        });

        if (result.project) {
          setProjects(function (currentProjects) {
            return currentProjects.map(function (project) {
            return project.id === result.project.id ? result.project : project;
            });
          });
        }
        if (result.thread) {
          setProjectThread(result.thread);
        }

        setEditingProjectTitle(false);
        setMessage("Project title updated.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to rename project.");
      } finally {
        setBusy("");
      }
    }

    async function handleProjectTrust(trusted) {
      if (!activeProject) {
        return;
      }

      setBusy("trust-project");
      setError("");
      setMessage("");

      try {
        const result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/trust", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trusted: trusted === true })
        });
        if (result && result.project) {
          setProjects(function (currentProjects) {
            return (Array.isArray(currentProjects) ? currentProjects : []).map(function (project) {
              return project && project.id === result.project.id ? result.project : project;
            });
          });
          setActiveProjectId(result.project.id || null);
        }
        setMessage(trusted
          ? "Workspace trusted. ScopeGuard can now read project files and answer with full context."
          : "Workspace kept limited for now.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to update workspace trust.");
      } finally {
        setBusy("");
      }
    }

    async function handleTaskRenameSave() {
      const title = String(taskRenameDraft || "").trim();
      if (!activeTaskId) {
        setMessage("Open a task first.");
        return;
      }
      if (!title) {
        setMessage("Enter a task title first.");
        return;
      }

      setBusy("rename-task");
      setError("");
      setMessage("");

      try {
        const result = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(activeTaskId) + "/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title })
        });

        if (result.task) {
          setTaskDetail(result.task);
        }
        if (result.context) {
          setTaskContext(result.context);
        }
        if (result.thread) {
          setThread(result.thread);
        }
        if (activeProjectId) {
          await refreshTaskList(activeProjectId, activeTaskId);
        }

        setEditingTaskTitle(false);
        setMessage("Task title updated.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to rename task.");
      } finally {
        setBusy("");
      }
    }

    const activeProject = useMemo(function () {
      return projects.find(function (project) { return project.id === activeProjectId; }) || null;
    }, [projects, activeProjectId]);

    useEffect(function () {
      setProjectRenameDraft(activeProject ? activeProject.name : "");
      setEditingProjectTitle(false);
    }, [activeProjectId, activeProject ? activeProject.name : ""]);

    useEffect(function () {
      setTaskRenameDraft(taskDetail ? taskDetail.title : "");
      setEditingTaskTitle(false);
    }, [activeTaskId, taskDetail ? taskDetail.title : ""]);

    async function handleProjectMessageAction(action) {
      switch (action.intent) {
        case "start-task-conversation":
          await startTaskConversationFromProjectGoal(latestProjectGoal(projectThread, homeDraftInput));
          break;
        default:
          break;
      }
    }

    async function startTaskConversationFromProjectGoal(goal) {
      if (!activeProject || !projectThread) {
        setMessage("Open a project conversation first.");
        return;
      }

      setBusy("home");
      setError("");
      setMessage("");

      try {
        const result = await fetchJson("/api/desktop/projects/" + encodeURIComponent(activeProject.id) + "/start-task", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userGoal: goal,
            sourceThreadId: projectThread.id
          })
        });

        if (result.thread) {
          setThread(result.thread);
        }

        setHomeDraftInput("");
        await loadProjectTasks(activeProject.id, result.draftTask ? result.draftTask.id : null);
        if (result.draftTask) {
          await selectTask(activeProject.id, result.draftTask.id, true);
        }
        setMessage(result.draftTask && result.draftTask.title
          ? "Draft started: " + result.draftTask.title
          : "Draft task conversation started.");
      } catch (err) {
        setError(err && err.message ? err.message : "Failed to start the task conversation.");
      } finally {
        setBusy("");
      }
    }

    return h("div", { className: "window-shell" }, [
      h("header", { key: "titlebar", className: "titlebar" }, [
        h("div", { key: "menu", className: "menu" }, [
          h("span", { key: "brand" }, "ScopeGuard")
        ]),
        h("div", { key: "window-actions", className: "window-actions" }, [
          h("div", { key: "min", className: "window-btn min" }),
          h("div", { key: "max", className: "window-btn max" }),
          h("div", { key: "close", className: "window-btn close" })
        ])
      ]),
      h("div", { key: "shell", className: "shell" }, [
        h("aside", { key: "sidebar", className: "sidebar" }, [
          h("div", { key: "sidebar-top", className: "sidebar-top" }, [
            h("div", { key: "brand-block", className: "brand-block" }, [
              h("h1", { key: "brand-title" }, "ScopeGuard")
            ]),
            h("button", {
              key: "open-folder",
              className: "primary-sidebar-button",
              onClick: function () {
                void handleOpenProjectFolder();
              }
            }, "Open Project Folder"),
            h("div", { key: "section-label", className: "section-label" }, "Projects"),
            h("div", { key: "projects", className: "project-list" },
              projects.map(function (project) {
                const projectTasks = project.id === activeProjectId ? tasks : [];
                return h("section", {
                  key: project.id,
                  className: "project-card" + (project.id === activeProjectId ? " active" : "")
                }, [
                  h("button", {
                    key: "project-header",
                    className: "project-header",
                    type: "button",
                    onClick: function () { void selectProject(project.id); }
                  }, [
                    h("div", { key: "project-meta", className: "project-meta" }, [
                      h("h2", { key: "name" }, project.name),
                      h("p", { key: "path" }, project.rootPath)
                    ]),
                    h("span", { key: "count", className: "count" }, String(project.activeTaskCount))
                  ]),
                  project.id === activeProjectId
                    ? h("div", { key: "task-list", className: "task-list" },
                        projectTasks.length > 0
                          ? projectTasks.map(function (task) {
                              return h("button", {
                                key: task.id,
                                className: "task-row" + (task.id === activeTaskId ? " active" : ""),
                                type: "button",
                                onClick: function () { void selectTask(project.id, task.id, true); }
                              }, [
                                h("div", { key: "title", className: "task-title" }, [
                                  h("strong", { key: "strong" }, task.title),
                                  h("span", { key: "subtitle" }, task.subtitle)
                                ]),
                                h("div", { key: "status-group", className: "task-status-group" }, [
                                  h("span", { key: "badge", className: "status-badge status-" + slugStatus(task.status) }, task.status),
                                  (function () { var rb = null; if (task.rawStatus === "approved" || task.rawStatus === "merged" || task.rawStatus === "closed") { /* no badge for terminal states */ } else if (task.depBlocked) { rb = h("span", { key: "dep-badge", className: "review-meta-badge review-meta-pending" }, "Waiting on dependency"); } else if (task.reviewStatus === "needs_attention") { rb = h("span", { key: "review-badge", className: "review-meta-badge review-meta-needs-attn" }, "Needs attention"); } else if (task.reviewStatus === "ready_for_review") { rb = h("span", { key: "review-badge", className: "review-meta-badge review-meta-ready" }, "Ready for approval"); } else if (task.reviewAssignmentStatus === "claimed") { rb = h("span", { key: "review-badge", className: "review-meta-badge review-meta-claimed" }, "Review in progress"); } else if (task.reviewAssignmentStatus === "pending") { rb = h("span", { key: "review-badge", className: "review-meta-badge review-meta-pending" }, "Review queued"); } return rb; })()
                                ])
                              ]);
                            })
                          : h("div", { key: "empty", className: "empty-note" }, "No active tasks yet.")
                      )
                    : null
                ]);
              })
            )
          ]),
          h("div", { key: "sidebar-bottom", className: "sidebar-bottom" }, [
            h("button", {
              key: "settings-link",
              className: "side-link" + (view === "settings" ? " active" : ""),
              onClick: function () {
                void openSettings();
              }
            }, "Settings")
          ])
        ]),
        h("main", { key: "main", className: "main" }, [
          error ? h("div", { key: "error", className: "banner error" }, error) : null,
          message ? h("div", { key: "message", className: "banner" }, message) : null,
          loading ? h("div", { key: "loading", className: "banner muted" }, "Loading...") : null,
          busy ? h("div", { key: "busy", className: "banner muted" }, actionLabel(busy) + " in progress...") : null,
          view === "settings"
            ? renderSettings(aiConfig, setAIConfig, executorConfig, setExecutorConfig, saveSettings, busy, cliTestResults, handleTestCLI, handleOpenCLI, connectionGuideVisible, setConnectionGuideVisible, advancedGuideVisible, setAdvancedGuideVisible, buildQuickConnectText, buildAdvancedGuideText, handleCopyConnectionGuide, externalApiToken, setMessage, setError, runtimeInfo, WEB_BUILD_LABEL)
            : !activeProject
              ? renderEmptyState(folderNotice, handleOpenProjectFolder, handleInitializeProject)
              : view === "task" && taskDetail
                ? renderTaskWorkspace(activeProject, taskDetail, taskContext, thread, draftInput, setDraftInput, handleMessageAction, runTaskAction, handleSend, currentDrawerState(), toggleDrawer, editingTaskTitle, taskRenameDraft, setTaskRenameDraft, setEditingTaskTitle, handleTaskRenameSave, selectedContextFilePath, selectedContextFileContent, selectedContextFileLoading, openContextFilePreview, streamingTaskReply, executors, activeRun, handleTaskRun, handleCopyHandoff, handleImportExternalResult, handoffPreviewText, setHandoffPreviewText, lastCompletedRun, handleQueueAssignment, deletingDraft, setDeletingDraft, setMessage, setError, activeProjectId, loadProjectTasks, setView, setActiveTaskId, setTaskDetail, setTaskContext, setThread, externalApiToken)
                : renderHome(activeProject, tasks, projectThread, homeDraftInput, setHomeDraftInput, handleProjectMessageAction, handleHomeSend, handleInitializeProject, handleInitializeGit, handleOpenProjectFolder, handleProjectTrust, editingProjectTitle, projectRenameDraft, setProjectRenameDraft, setEditingProjectTitle, handleProjectRenameSave, selectTask, projectOverviewExpanded, setProjectOverviewExpanded, streamingProjectReply, planningTasks, planningBusy, recentRuns, projectSummary, projectTaskSummary, capabilityMenuVisible, setCapabilityMenuVisible, handleProjectPlan, handleBatchQueue, handleBatchCancel, startTaskConversationFromProjectGoal, openSettings, setConnectionGuideVisible, connectedClients, executors, externalApiToken, showAddTaskForm, setShowAddTaskForm, showImportPlanForm, setShowImportPlanForm, importPlanText, setImportPlanText, addTaskTitle, setAddTaskTitle, setPlanningTasks, setMessage, setError, activeProjectId, loadProjectTasks, refreshProjectOverview, deletePersistedProposalItems)
        ])
      ])
    ]);
  }

  function validateAIConfig(aiConfig) {
    if (!aiConfig || typeof aiConfig !== "object") {
      return "AI settings are incomplete.";
    }

    if (!aiConfig.provider) {
      return "Choose a provider first.";
    }

    if ((aiConfig.provider === "openai-compatible" || aiConfig.provider === "anthropic") && !String(aiConfig.apiKey || "").trim()) {
      return "API Key is required for the selected provider.";
    }

    if ((aiConfig.provider === "openai-compatible" || aiConfig.provider === "anthropic") && !String(aiConfig.model || "").trim()) {
      return "Model is required for the selected provider.";
    }

    if (aiConfig.provider === "codex-account" && !String(aiConfig.codexBin || "").trim()) {
      return "Codex Bin is required for codex-account.";
    }

    return "";
  }

  function getProviderPresets() {
    return [
      {
        id: "openai-gpt",
        label: "OpenAI (GPT)",
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini"
      },
      {
        id: "anthropic-claude",
        label: "Anthropic (Claude)",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-20250514"
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        provider: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash"
      },
      {
        id: "zhipu-glm",
        label: "Zhipu GLM",
        provider: "openai-compatible",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.1"
      },
      {
        id: "minimax",
        label: "MiniMax",
        provider: "openai-compatible",
        baseUrl: "https://api.minimax.io/v1",
        model: "MiniMax-M2.7"
      },
      {
        id: "minimax-cn",
        label: "MiniMax (China)",
        provider: "openai-compatible",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M2.7"
      },
      {
        id: "codex-account",
        label: "Codex Account",
        provider: "codex-account",
        baseUrl: "",
        model: ""
      }
    ];
  }

  function normalizeBaseUrl(baseUrl, provider) {
    let normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!normalized) {
      return normalized;
    }

    if (provider === "anthropic") {
      return normalized.replace(/\/messages$/i, "");
    }

    return normalized
      .replace(/\/chat\/completions$/i, "")
      .replace(/\/responses$/i, "")
      .replace(/\/models$/i, "");
  }

  function renderSettings(aiConfig, setAIConfig, executorConfig, setExecutorConfig, saveSettings, busy, cliTestResults, handleTestCLI, handleOpenCLI, connectionGuideVisible, setConnectionGuideVisible, advancedGuideVisible, setAdvancedGuideVisible, buildQuickConnectText, buildAdvancedGuideText, handleCopyConnectionGuide, externalApiToken, setMessage, setError, runtimeInfo, webBuildLabel) {
    const presets = getProviderPresets();
    const provider = String(aiConfig && aiConfig.provider || "openai-compatible");
    const presetId = String(aiConfig && aiConfig.providerPreset || "");
    const activePreset = presets.find(function (preset) { return preset.id === presetId; })
      || presets.find(function (preset) {
        return preset.provider === provider
          && (!aiConfig.baseUrl || normalizeBaseUrl(aiConfig.baseUrl, provider) === preset.baseUrl);
      })
      || (provider === "anthropic"
        ? presets.find(function (preset) { return preset.id === "anthropic-claude"; })
        : provider === "codex-account"
          ? presets.find(function (preset) { return preset.id === "codex-account"; })
          : presets.find(function (preset) { return preset.id === "openai-gpt"; }))
      || presets[0];
    const isSaving = busy === "settings";
    const validationError = validateAIConfig(aiConfig);
    const needsApiFields = provider === "openai-compatible" || provider === "anthropic";
    const needsCodexBin = provider === "codex-account";

    return h("div", { className: "center-shell" }, [
      h("section", { className: "hero-card settings-card" }, [
        h("div", { className: "hero-copy" }, [
          h("h2", null, "ScopeGuard LLM"),
          h("p", null, "Lightweight assistant for summaries, reviews, and routing. Planning is handled by Claude CLI.")
        ]),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "Saved per workspace"),
          h("span", { className: "settings-help-text" }, needsApiFields
            ? "Fill provider, model, base URL, and API key. ScopeGuard stores this locally for the current workspace."
            : "Point ScopeGuard at your local Codex CLI binary for this workspace.")
        ]),
        h("div", { className: "settings-grid" }, [
          renderSettingsField("Provider Preset", h("select", {
            className: "settings-input",
            value: activePreset ? activePreset.id : "openai-gpt",
            onChange: function (event) {
              const nextPreset = presets.find(function (preset) { return preset.id === event.target.value; }) || presets[0];
              setAIConfig({
                ...aiConfig,
                providerPreset: nextPreset.id,
                provider: nextPreset.provider,
                baseUrl: nextPreset.baseUrl,
                model: nextPreset.model,
              });
            }
          }, presets.map(function (preset) {
            return h("option", { key: preset.id, value: preset.id }, preset.label);
          }))),
          renderSettingsField("Protocol", h("input", {
            className: "settings-input",
            value: provider,
            readOnly: true
          })),
          renderSettingsField("Model", h("input", {
            className: "settings-input",
            value: aiConfig.model,
            onChange: function (event) {
              setAIConfig({ ...aiConfig, model: event.target.value });
            }
          })),
          needsApiFields
            ? renderSettingsField("Base URL", h("input", {
                className: "settings-input",
                value: aiConfig.baseUrl,
                placeholder: provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
                onChange: function (event) {
                  setAIConfig({ ...aiConfig, baseUrl: normalizeBaseUrl(event.target.value, provider) });
                }
              }))
            : null,
          needsApiFields
            ? renderSettingsField("API Key", h("input", {
                className: "settings-input",
                type: "password",
                value: aiConfig.apiKey,
                placeholder: "Paste your API key",
                onChange: function (event) {
                  setAIConfig({ ...aiConfig, apiKey: event.target.value });
                }
              }))
            : null,
          needsCodexBin
            ? renderSettingsField("Codex Bin", h("input", {
                className: "settings-input",
                value: aiConfig.codexBin,
                placeholder: "C:\\Users\\<you>\\AppData\\Roaming\\npm\\codex.cmd",
                onChange: function (event) {
                  setAIConfig({ ...aiConfig, codexBin: event.target.value });
                }
              }))
            : null
        ]),
        h("div", { className: "settings-section-label settings-section-label-primary" }, "Connected Agents / MCP"),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "API Token (required)"),
          h("span", { className: "settings-help-text" }, "All external executor API calls require this token in the Authorization: Bearer header. Copy it for your MCP bridge or reference script.")
        ]),
        externalApiToken
          ? h("div", { className: "settings-field" }, [
              h("span", { className: "settings-label" }, "Bearer Token"),
              h("div", { className: "token-display-row" }, [
                h("input", {
                  className: "settings-input token-display-input",
                  type: "text",
                  readOnly: true,
                  value: externalApiToken,
                }),
                h("button", {
                  className: "chip-button",
                  type: "button",
                  onClick: function () {
                    void navigator.clipboard.writeText(externalApiToken).then(function () { setMessage("Token copied to clipboard."); }).catch(function () { setError("Clipboard access denied."); });
                  }
                }, "Copy")
              ])
            ])
          : h("div", { className: "settings-inline-note" }, "Token will be generated when you open a project."),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "MCP / Connected Executor"),
          h("span", { className: "settings-help-text" }, "Primary route: connect an external agent (Claude CLI, Codex CLI, custom MCP bridge) once, then let ScopeGuard route matching tasks automatically. Reference script: scripts/external-bridge-example.js. MCP bridge: scripts/scopeguard-mcp-bridge.js (generic stdio MCP server for Claude Desktop, Codex, OpenCode, etc.).")
        ]),
        h("button", {
          className: "secondary-button",
          type: "button",
          onClick: function () { setConnectionGuideVisible(!connectionGuideVisible); }
        }, connectionGuideVisible ? "Hide Connection Guide" : "Show Connection Guide"),
        connectionGuideVisible
          ? h("div", { className: "connection-guide-panel" }, [
              h("div", { className: "connection-guide-header" }, [
                h("span", null, "Quick Connect"),
                h("button", {
                  className: "chip-button",
                  style: { fontSize: "11px", marginLeft: "auto" },
                  onClick: function () { void handleCopyConnectionGuide(); }
                }, "Copy guide")
              ]),
              h("pre", { className: "connection-guide-body" }, buildQuickConnectText()),
              h("button", {
                className: "secondary-button",
                style: { marginTop: "8px", fontSize: "11px" },
                type: "button",
                onClick: function () { setAdvancedGuideVisible(!advancedGuideVisible); }
              }, advancedGuideVisible ? "Hide Full Protocol Details" : "Show Full Protocol Details"),
              advancedGuideVisible
                ? h("pre", { className: "connection-guide-body", style: { marginTop: "8px" } }, buildAdvancedGuideText())
                : null
            ])
          : null,
        h("div", { className: "settings-section-label settings-section-label-primary" }, "Companion Worker (Optional Automation)"),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "Optional semi-automatic execution"),
          h("span", { className: "settings-help-text" }, "A user-run companion process that continuously polls for queued tasks, claims them, and reports results back. Run the reference bridge in pull mode after connecting your agent. This is optional — standard MCP integration does not require it.")
        ]),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "Reference bridge pull mode"),
          h("span", { className: "settings-help-text" }, "node scripts/external-bridge-example.js --mode pull --token <token>")
        ]),
        h("div", { className: "settings-section-label" }, "Local CLI Launch (Experimental / Fallback)"),
        h("div", { className: "settings-help" }, [
          h("span", { className: "settings-help-title" }, "Advanced local launch"),
          h("span", { className: "settings-help-text" }, "Fallback path - runs Claude CLI or Codex CLI locally from ScopeGuard. This may not reflect the full write, approval, or sandbox behavior of your external agent environment.")
        ]),
        renderExecutorSettingsRow("Codex CLI", "codex-cli", executorConfig.codexCommand, function (v) { setExecutorConfig({ ...executorConfig, codexCommand: v }); }, cliTestResults, handleTestCLI, handleOpenCLI),
        renderExecutorSettingsRow("Claude CLI", "claude-cli", executorConfig.claudeCommand, function (v) { setExecutorConfig({ ...executorConfig, claudeCommand: v }); }, cliTestResults, handleTestCLI, handleOpenCLI),
        runtimeInfo
          ? h("div", { className: "settings-section-label" }, "Build / Runtime Identity")
          : null,
        runtimeInfo
          ? h("div", { className: "runtime-info-grid", style: { padding: "8px 0", borderTop: "1px solid #e0e0e0", marginTop: "8px", fontSize: "12px", lineHeight: "1.6" } }, [
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Web bundle:"),
                h("span", { style: { color: "#333" } }, webBuildLabel || "unknown")
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Server version:"),
                h("span", { style: { color: "#333" } }, String(runtimeInfo.serverVersion || "?"))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Server build:"),
                h("span", { style: { color: "#333" } }, formatRuntimeDate(runtimeInfo.buildTime))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Server boot:"),
                h("span", { style: { color: "#333" } }, formatRuntimeDate(runtimeInfo.bootTime))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "PID:"),
                h("span", { style: { color: "#333" } }, String(runtimeInfo.pid || "?"))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Platform:"),
                h("span", { style: { color: "#333" } }, String(runtimeInfo.platform || "?") + " " + String(runtimeInfo.arch || ""))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Node:"),
                h("span", { style: { color: "#333" } }, String(runtimeInfo.nodeVersion || "?"))
              ]),
              h("div", { className: "runtime-info-row", style: { display: "flex", gap: "8px" } }, [
                h("span", { style: { fontWeight: 600, minWidth: "110px", color: "#555" } }, "Git root:"),
                h("span", { style: { color: "#666", wordBreak: "break-all" } }, String(runtimeInfo.gitRoot || "?"))
              ])
            ])
          : null,
        validationError
          ? h("div", { className: "settings-inline-note error" }, validationError)
          : h("div", { className: "settings-inline-note" }, "After saving, go back to a project or task conversation and send a real prompt to test the provider."),
        h("div", { className: "hero-actions" }, [
          h("button", {
            className: "primary-button",
            type: "button",
            disabled: isSaving,
            onClick: function () {
              void saveSettings();
            }
          }, isSaving ? "Saving..." : "Save Settings")
        ])
      ])
    ]);
  }

  function renderSettingsField(label, control) {
    return h("label", { className: "settings-field" }, [
      h("span", { className: "settings-label" }, label),
      control
    ]);
  }

  function renderExecutorSettingsRow(displayName, executorId, commandValue, setCommand, cliTestResults, handleTestCLI, handleOpenCLI) {
    var testResult = cliTestResults && cliTestResults[executorId];
    return h("div", { className: "executor-settings-row" }, [
      h("div", { className: "executor-settings-header" }, [
        h("strong", null, displayName),
        h("span", { className: "executor-settings-id" }, executorId)
      ]),
      renderSettingsField("Command", h("input", {
        className: "settings-input",
        value: commandValue,
        placeholder: executorId === "codex-cli" ? "codex" : "claude",
        onChange: function (event) { setCommand(event.target.value); }
      })),
      h("div", { className: "executor-settings-actions" }, [
        h("button", {
          className: "chip-button",
          onClick: function () { void handleTestCLI(executorId); }
        }, "Test CLI"),
        h("button", {
          className: "chip-button",
          onClick: function () { void handleOpenCLI(executorId); }
        }, "Open CLI Setup")
      ]),
      testResult
        ? h("div", { className: "executor-test-result " + (testResult.ok ? "ok" : "fail") }, [
            h("span", null, testResult.message),
            testResult._debug
              ? h("pre", { className: "executor-debug-info" }, JSON.stringify(testResult._debug, null, 2))
              : null
          ])
        : null
    ]);
  }

  function renderEmptyState(folderNotice, handleOpenProjectFolder, handleInitializeProject) {
    return h("div", { className: "center-shell" }, [
      h("section", { className: "hero-card" }, [
        h("div", { className: "hero-copy" }, [
          h("h2", null, "Open a project folder to begin"),
          h("p", null, folderNotice
            ? folderNotice.message
            : "Choose an initialized ScopeGuard repository to start a project conversation.")
        ]),
        h("div", { className: "hero-actions" }, [
          h("button", {
            className: "primary-button",
            onClick: function () {
              void handleOpenProjectFolder();
            }
          }, "Open Project Folder"),
          folderNotice
            ? h("button", {
                className: "secondary-button",
                onClick: function () {
                  void handleInitializeProject();
                }
              }, "Initialize ScopeGuard")
            : null
        ])
      ])
    ]);
  }

  function renderEditableTitle(title, isEditing, draftValue, setDraftValue, setEditing, handleSave, renameLabel) {
    if (isEditing) {
      return h("div", { className: "title-edit-row" }, [
        h("input", {
          className: "title-edit-input",
          value: draftValue,
          onChange: function (event) { setDraftValue(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSave();
            }
            if (event.key === "Escape") {
              setEditing(false);
            }
          }
        }),
        h("div", { className: "title-inline-actions" }, [
          h("button", {
            className: "chip-button",
            onClick: function () {
              void handleSave();
            }
          }, "Save"),
          h("button", {
            className: "ghost-button",
            onClick: function () {
              setDraftValue(title);
              setEditing(false);
            }
          }, "Cancel")
        ])
      ]);
    }

    return h("div", { className: "task-title-row" }, [
      h("h2", null, title),
      h("button", {
        className: "title-rename-button",
        onClick: function () {
          setDraftValue(title);
          setEditing(true);
        }
      }, renameLabel || "Rename")
    ]);
  }

  function renderHome(project, tasks, projectThread, homeDraftInput, setHomeDraftInput, handleProjectMessageAction, handleHomeSend, handleInitializeProject, handleInitializeGit, handleOpenProjectFolder, handleProjectTrust, editingProjectTitle, projectRenameDraft, setProjectRenameDraft, setEditingProjectTitle, handleProjectRenameSave, selectTask, projectOverviewExpanded, setProjectOverviewExpanded, streamingProjectReply, planningTasks, planningBusy, recentRuns, projectSummary, projectTaskSummary, capabilityMenuVisible, setCapabilityMenuVisible, handleProjectPlan, handleBatchQueue, handleBatchCancel, startTaskConversationFromProjectGoal, openSettings, setConnectionGuideVisible, connectedClients, executors, externalApiToken, showAddTaskForm, setShowAddTaskForm, showImportPlanForm, setShowImportPlanForm, importPlanText, setImportPlanText, addTaskTitle, setAddTaskTitle, setPlanningTasks, setMessage, setError, activeProjectId, loadProjectTasks, refreshProjectOverview, deletePersistedProposalItems) {
  var isLocalWorkspace = project.source === "local-folder";
  var isManagedProject = project.isInitialized;
  var activeTasks = Array.isArray(tasks) ? tasks : [];
  var reviewCount = activeTasks.filter(function (t) { return t.status === "Awaiting Review"; }).length;
  var blockedCount = activeTasks.filter(function (t) { return t.status === "Blocked"; }).length;
  
  // ── Proposal readiness helper ──
  function proposalTaskReadiness(pt) {
    var hasTitle = typeof pt.title === "string" && pt.title.trim().length > 0;
    var hasGoal = typeof pt.goal === "string" && pt.goal.trim().length > 0;
    var hasFiles = Array.isArray(pt.allowedFiles) && pt.allowedFiles.length > 0;
    var hasCriteria = Array.isArray(pt.acceptanceCriteria) && pt.acceptanceCriteria.length > 0;
    var hasExecutor = typeof pt.preferredExecutor === "string" && pt.preferredExecutor.length > 0;
    var hasCommands = Array.isArray(pt.commands) && pt.commands.length > 0;
    var missing = [];
    if (!hasFiles) missing.push("scope");
    if (!hasCriteria) missing.push("criteria");
    if (!hasExecutor) missing.push("executor");
    if (!hasFiles && !hasCriteria && !hasExecutor && !hasCommands) return { state: "too-vague", missing: missing, label: "Too Vague" };
    if (missing.length > 0) return { state: "needs-review", missing: missing, label: "Needs Review" };
    return { state: "ready", missing: [], label: "Ready" };
  }

  function proposalReadiness(tasks) {
    if (!tasks || tasks.length === 0) return { state: "too-vague", label: "Too Vague", summary: "No tasks in proposal.", canCommit: false };
    var results = tasks.map(proposalTaskReadiness);
    var anyVague = results.some(function (r) { return r.state === "too-vague"; });
    var anyReview = results.some(function (r) { return r.state === "needs-review"; });
    var allReady = results.every(function (r) { return r.state === "ready"; });
    if (anyVague) {
      var cv = results.filter(function (r) { return r.state === "too-vague"; }).length;
      return { state: "too-vague", label: "Too Vague", summary: cv + " task(s) too vague — refine before committing.", canCommit: false };
    }
    if (anyReview) {
      var cn = results.filter(function (r) { return r.state === "needs-review"; }).length;
      return { state: "needs-review", label: "Needs Review", summary: cn + " task(s) need review — add scope, criteria, or executor.", canCommit: true };
    }
    if (allReady) return { state: "ready-to-commit", label: "Ready to Commit", summary: "All tasks ready to commit.", canCommit: true };
    return { state: "needs-review", label: "Needs Review", summary: "Some tasks need review.", canCommit: true };
  }

  function normalizeImportedProposalTask(raw, index) {
    var item = raw && typeof raw === "object" ? raw : {};
    var title = String(item.title || item.name || "Imported task " + String(index + 1)).trim();
    var goal = String(item.goal || item.description || title).trim();
    function stringArray(value) {
      if (Array.isArray(value)) return value.map(function (entry) { return String(entry).trim(); }).filter(Boolean);
      if (typeof value === "string" && value.trim()) return value.split(/\r?\n|,/).map(function (entry) { return entry.trim(); }).filter(Boolean);
      return [];
    }
    var preferred = item.preferredExecutor || item.assignedExecutor || "claude-cli";
    return {
      id: item.id || "IMPORTED-" + Date.now() + "-" + String(index),
      title: title,
      goal: goal,
      allowedFiles: stringArray(item.allowedFiles || item.files),
      acceptanceCriteria: stringArray(item.acceptanceCriteria || item.criteria),
      commands: stringArray(item.commands),
      preferredExecutor: preferred === "codex-cli" ? "codex-cli" : "claude-cli",
      assignedExecutor: item.assignedExecutor || preferred,
      dependsOn: stringArray(item.dependsOn || item.dependencies),
      parallelizable: item.parallelizable === true,
      priority: ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium"
    };
  }

  function parsePlanTextToTasks(rawText) {
    var lines = String(rawText || "").split(/\r?\n/);
    var tasks = [];
    var current = null;
    function pushCurrent() {
      if (current && current.title) {
        tasks.push(current);
      }
      current = null;
    }
    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var taskMatch = trimmed.match(/^(?:[-*]\s+|\d+[\.)]\s+)(?:\[[^\]]+\]\s*)?(.+)$/);
      var headingMatch = trimmed.match(/^#{2,6}\s+(.+)$/);
      if (taskMatch || headingMatch) {
        pushCurrent();
        var title = (taskMatch ? taskMatch[1] : headingMatch[1]).replace(/^\*\*|\*\*$/g, "").trim();
        current = { title: title, goal: title, acceptanceCriteria: [], allowedFiles: [], commands: [] };
        return;
      }
      if (!current) return;
      var files = trimmed.match(/^(?:files?|allowedFiles?|scope)\s*:\s*(.+)$/i);
      var criteria = trimmed.match(/^(?:criteria|acceptanceCriteria|acceptance)\s*:\s*(.+)$/i);
      var commands = trimmed.match(/^(?:commands?|verify|verification)\s*:\s*(.+)$/i);
      var executor = trimmed.match(/^(?:executor|preferredExecutor|assignedExecutor)\s*:\s*(.+)$/i);
      if (files) {
        current.allowedFiles = files[1].split(/[,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
      } else if (criteria) {
        current.acceptanceCriteria.push(criteria[1].trim());
      } else if (commands) {
        current.commands.push(commands[1].replace(/^`|`$/g, "").trim());
      } else if (executor) {
        current.preferredExecutor = /codex/i.test(executor[1]) ? "codex-cli" : "claude-cli";
      } else {
        current.goal = current.goal === current.title ? trimmed : current.goal + " " + trimmed;
      }
    });
    pushCurrent();
    return tasks;
  }

  function importPlanFromText() {
    console.log("[scopeguard-web] import plan clicked");
    try {
      if (!showImportPlanForm) {
        setShowImportPlanForm(true);
        setImportPlanText("");
        setMessage("Paste a plan JSON or Markdown task list.");
        return;
      }
      setMessage("Importing...");
      var rawText = (importPlanText || "").trim();
      if (!rawText) {
        setShowImportPlanForm(false);
        setError("No plan text provided.");
        return;
      }
      console.log("[scopeguard-web] importPlanFromText: length=" + rawText.length);
      try {
        var parsed = JSON.parse(rawText);
      var rawTasks = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
      if (!rawTasks.length) {
        setError("Import failed: JSON must contain a tasks array.");
        return;
      }
      var imported = rawTasks.map(normalizeImportedProposalTask);
      setPlanningTasks(imported);
      setShowImportPlanForm(false);
      setImportPlanText("");
      setMessage("Imported " + String(imported.length) + " proposal task(s).");
    } catch (err) {
      console.log("[scopeguard-web] importPlanFromText: JSON parse failed, trying text parse");
      var textTasks = parsePlanTextToTasks(rawText);
      if (!textTasks.length) {
        setError("Import failed: paste JSON with tasks, or a Markdown bullet/numbered task list.");
        return;
      }
      var textImported = textTasks.map(normalizeImportedProposalTask);
      setPlanningTasks(textImported);
      setShowImportPlanForm(false);
      setImportPlanText("");
      setMessage("Imported " + String(textImported.length) + " text proposal task(s).");
    }
    } catch (err) {
      console.log("[scopeguard-web] importPlanFromText ERROR: " + (err && err.message || err));
      setError("Import failed: " + (err && err.message || err));
    }
  }

  function addProposalTask() {
    console.log("[scopeguard-web] add task clicked");
    try {
      if (!showAddTaskForm) {
        setShowAddTaskForm(true);
        setAddTaskTitle("");
        setMessage("Enter a title for the new proposal task.");
        return;
      }
      var title = (addTaskTitle || "").trim();
      if (!title) {
        setError("Task title is required.");
        return;
      }
      console.log("[scopeguard-web] addProposalTask: title=" + title);
      var task = normalizeImportedProposalTask({ title: title, goal: title }, planningTasks.length);
      setPlanningTasks(planningTasks.concat([task]));
      setShowAddTaskForm(false);
      setAddTaskTitle("");
      setMessage("Added proposal task: " + task.title);
    } catch (err) {
      console.log("[scopeguard-web] addProposalTask ERROR: " + (err && err.message || err));
      setError("Add task failed: " + (err && err.message || err));
    }
  }

  function editProposalTask(pt, ptIdx) {
    console.log("[scopeguard-web] edit proposal task clicked: idx=" + ptIdx);
    try {
      var editable = {
        title: pt.title || "",
        goal: pt.goal || pt.title || "",
        allowedFiles: pt.allowedFiles || [],
        acceptanceCriteria: pt.acceptanceCriteria || [],
        commands: pt.commands || [],
        preferredExecutor: pt.preferredExecutor || "claude-cli",
        assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli",
        dependsOn: pt.dependsOn || [],
        parallelizable: pt.parallelizable === true,
        priority: pt.priority || "medium"
      };
      setImportPlanText(JSON.stringify(editable, null, 2));
      setShowImportPlanForm(true);
      setMessage("Edit the task JSON below and click Import Plan to apply.");
    } catch (err) {
      setError("Edit failed: " + (err && err.message ? err.message : "unknown error"));
    }
  }

  function normalizeCurrentProposal() {
    if (!project || !planningTasks || planningTasks.length === 0) return;
    setMessage("Normalizing proposal...");
    var payload = {
      tasks: planningTasks.map(function (pt) {
        return {
          title: pt.title,
          goal: pt.goal || pt.title,
          allowedFiles: pt.allowedFiles || [],
          acceptanceCriteria: pt.acceptanceCriteria || [],
          commands: pt.commands || [],
          preferredExecutor: pt.preferredExecutor || "claude-cli",
          assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli",
          dependsOn: pt.dependsOn || [],
          parallelizable: pt.parallelizable || false,
          priority: pt.priority || "medium"
        };
      })
    };
    fetchJson("/api/desktop/projects/" + encodeURIComponent(project.id) + "/normalize-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (result) {
      if (result.ok && Array.isArray(result.tasks)) {
        setPlanningTasks(result.tasks.map(function (task, index) {
          return Object.assign({}, task, {
            id: planningTasks[index] && planningTasks[index].id ? planningTasks[index].id : "IMPORTED-" + Date.now() + "-" + String(index)
          });
        }));
        setMessage(result.readiness && result.readiness.summary ? "Proposal normalized. " + result.readiness.summary : "Proposal normalized.");
      } else {
        setError("Normalize returned no tasks.");
      }
    }).catch(function (err) {
      setError("Normalize failed: " + (err.message || err));
    });
  }

return h("div", { className: "workspace-shell" }, [
    // Header bar
    h("section", { className: "task-header-card project-header-bar" }, [
      h("div", { className: "task-header-copy project-header-copy" }, [
        h("div", { className: "project-header-line" }, [
          h("div", { className: "project-header-main" }, [
            renderEditableTitle(project.name, editingProjectTitle, projectRenameDraft, setProjectRenameDraft, setEditingProjectTitle, handleProjectRenameSave, "Rename project"),
            h("div", { className: "project-header-meta" }, [
              h("span", { className: "mode-badge" }, isManagedProject ? "Managed" : isLocalWorkspace ? "Workspace" : "Git Repo"),
              project.defaultBranch ? h("span", { className: "title-caption" }, "Branch " + project.defaultBranch) : null,
              h("span", { className: "title-caption" }, String(activeTasks.length) + " open task(s)"),
              connectedClients && connectedClients.length > 0 ? h("span", { className: "title-caption connected-clients-badge" }, (function () {
  var grouped = {};
  connectedClients.forEach(function (c) {
    var key = c.executorId || "unknown";
    if (!grouped[key] || (c.status === "online" && grouped[key].status !== "online")) {
      grouped[key] = c;
    }
  });
  var parts = [];
  for (var exId in grouped) {
    var ex = grouped[exId];
    parts.push(ex.status === "online"
      ? executorDisplayName(executors, exId)
      : executorDisplayName(executors, exId) + " (" + ex.status + ")");
  }
  return parts.length > 0 ? parts.join(", ") + " online" : "0 agents online";
})()) : null,
              projectTaskSummary && projectTaskSummary.readyToQueue > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.readyToQueue) + " ready to queue") : null,
              projectTaskSummary && projectTaskSummary.queued > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.queued) + " queued") : null,
              projectTaskSummary && projectTaskSummary.awaitingReview > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.awaitingReview) + " in review") : null,
              projectTaskSummary && projectTaskSummary.blockedByDependency > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.blockedByDependency) + " blocked by dependency") : null,
              projectTaskSummary && projectTaskSummary.needsAttention > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.needsAttention) + " needs attention") : null,
              projectTaskSummary && projectTaskSummary.approved > 0 ? h("span", { className: "title-caption" }, String(projectTaskSummary.approved) + " approved") : null,
            ])
          ]),
          h("div", { className: "project-header-path" }, project.rootPath)
        ])
      ]),
      h("div", { className: "header-actions" }, [
        isLocalWorkspace ? h("button", { className: "primary-button", onClick: function () { void handleInitializeGit(); } }, "Initialize Git") : null,
        !isManagedProject && !isLocalWorkspace ? h("button", { className: "primary-button", onClick: function () { void handleInitializeProject(); } }, "Enable Managed Project") : null,
        projectTaskSummary && projectTaskSummary.readyToQueue > 0
          ? h("button", { className: "primary-button", style: { marginLeft: "4px" }, onClick: function () { void handleBatchQueue(); } }, "Queue ready tasks (" + String(projectTaskSummary.readyToQueue) + ")")
          : null,
        projectTaskSummary && projectTaskSummary.queued > 0
          ? h("button", { className: "ghost-button", style: { marginLeft: "4px", color: "#c44" }, onClick: function () { void handleBatchCancel(); } }, "Cancel active dispatches (" + String(projectTaskSummary.queued) + ")")
          : null,
        h("button", { className: "ghost-button", title: "Open project folder", onClick: function () { void handleOpenProjectFolder(); } }, "[Folder]")
      ])
    ]),
    // Token bar
    h("div", { className: "token-bar" }, [
      externalApiToken
        ? h("div", { key: "token-controls", className: "token-controls" }, [
            h("span", { key: "token-label", className: "token-label" }, "Bearer Token"),
            h("input", { key: "token-input", className: "token-display-input token-bar-input", type: "text", readOnly: true, value: externalApiToken, style: { width: "200px", fontSize: "10px", fontFamily: "monospace" } }),
            h("button", { key: "token-copy", className: "chip-button", type: "button", style: { fontSize: "10px" }, onClick: function () { void navigator.clipboard.writeText(externalApiToken).then(function () { setMessage("Token copied."); }).catch(function () { setError("Clipboard access denied."); }); } }, "Copy"),
            h("button", { key: "token-copy-env", className: "chip-button", type: "button", style: { fontSize: "10px" }, onClick: function () {
              var envBlock = buildProjectMCPEnv(project.rootPath, externalApiToken);
              void navigator.clipboard.writeText(envBlock).then(function () { setMessage("MCP env config copied."); }).catch(function () { setError("Clipboard access denied."); });
            } }, "Copy MCP Env")
          ])
        : h("span", { className: "token-bar-pending" }, "Loading token...")
    ]),
    // Plan Workspace main area
    planningTasks && planningTasks.length > 0
      ? (function () { var prepState = proposalReadiness(planningTasks); return h("section", { className: "plan-workspace-main" }, [
          h("div", { className: "proposal-header" }, [
            h("div", { className: "proposal-header-info" }, [
              h("strong", null, "Current Proposal"),
              h("span", { className: "proposal-count" }, String(planningTasks.length) + " task(s)")
            ]),
            h("div", { className: "proposal-status-badge " + prepState.state }, prepState.label),
            h("div", { className: "proposal-actions-condensed" }, [
              h("button", { className: "ghost-button", onClick: addProposalTask }, "Add Proposal Task"),
              h("button", { className: "ghost-button", onClick: function () { void handleProjectPlan(homeDraftInput || project.name, { discardExistingProposal: true }); } }, "Re-plan"),
              h("button", { className: "ghost-button", onClick: function () {
                setMessage("Discarding proposal...");
                fetchJson("/api/desktop/projects/" + encodeURIComponent(project.id) + "/drafts", { method: "DELETE" }).then(function () {
                  setPlanningTasks([]);
                  setMessage("Proposal discarded.");
                  if (activeProjectId) {
                    void loadProjectTasks(activeProjectId, null);
                  }
                  void refreshProjectOverview();
                }).catch(function (err) {
                  setError("Failed to discard: " + (err.message || err));
                });
              } }, "Discard")
            ])
          ]),
                    showAddTaskForm
            ? h("div", { className: "inline-editor" }, [
                h("input", { className: "inline-editor-input", type: "text", value: addTaskTitle, placeholder: "Task title", onChange: function (e) { setAddTaskTitle(e.target.value); } }),
                h("div", { className: "inline-editor-actions" }, [
                  h("button", { className: "chip-button", onClick: function () { addProposalTask(); } }, "Add"),
                  h("button", { className: "ghost-button", onClick: function () { setShowAddTaskForm(false); setAddTaskTitle(""); } }, "Cancel")
                ])
              ])
            : null,
          showImportPlanForm
            ? h("div", { className: "inline-editor" }, [
                h("textarea", { className: "inline-editor-textarea", value: importPlanText, placeholder: "Paste JSON task array or Markdown task list...", onChange: function (e) { setImportPlanText(e.target.value); } }),
                h("div", { className: "inline-editor-actions" }, [
                  h("button", { className: "chip-button", onClick: function () { importPlanFromText(); } }, "Import"),
                  h("button", { className: "ghost-button", onClick: function () { setShowImportPlanForm(false); setImportPlanText(""); } }, "Cancel")
                ])
              ])
            : null,          h("div", { className: "proposal-task-list" }, planningTasks.map(function (pt, ptIdx) {
            var execLabel = pt.preferredExecutor === "codex-cli" ? "Codex" : "Claude";
            var priLabel = pt.priority && pt.priority !== "medium" ? pt.priority + " priority" : null;
            return h("div", { key: pt.id || ptIdx, className: "proposal-task-item" }, [
              h("div", { className: "proposal-task-header" }, [
                h("span", { className: "proposal-task-title" }, pt.title),
                h("span", { className: "proposal-task-executor" }, execLabel)
              ]),
              pt.goal ? h("div", { className: "proposal-task-goal" }, pt.goal) : null,
              Array.isArray(pt.allowedFiles) && pt.allowedFiles.length > 0 ? h("div", { className: "proposal-task-detail" }, "Files: " + pt.allowedFiles.join(", ")) : null,
              Array.isArray(pt.acceptanceCriteria) && pt.acceptanceCriteria.length > 0 ? h("div", { className: "proposal-task-detail" }, "Criteria: " + pt.acceptanceCriteria.join("; ")) : null,
              Array.isArray(pt.commands) && pt.commands.length > 0 ? h("div", { className: "proposal-task-detail" }, "Commands: " + pt.commands.join("; ")) : null,
              pt.dependsOn && pt.dependsOn.length > 0 ? h("div", { className: "proposal-task-detail" }, "Depends on: " + pt.dependsOn.join(", ")) : null,
              priLabel ? h("div", { className: "proposal-task-detail" }, priLabel) : null,
              h("button", { className: "ghost-button proposal-task-edit", title: "Edit proposal task", onClick: function () { editProposalTask(pt, ptIdx); } }, "Edit"),
              h("button", { className: "ghost-button proposal-task-remove", title: "Remove from proposal", onClick: function () {
                if (!pt.id) {
                  setError("Cannot remove: task has no ID.");
                  return;
                }
                if (String(pt.id).startsWith("IMPORTED-")) {
                  var importedUpdate = planningTasks.slice();
                  importedUpdate.splice(ptIdx, 1);
                  setPlanningTasks(importedUpdate);
                  setMessage("Removed imported task: " + pt.title);
                  return;
                }
                setMessage("Removing...");
                fetchJson("/api/desktop/tasks/draft/" + encodeURIComponent(pt.id), { method: "DELETE" }).then(function () {
                  var updated = planningTasks.slice();
                  updated.splice(ptIdx, 1);
                  setPlanningTasks(updated);
                  setMessage("Removed: " + pt.title);
                }).catch(function (err) {
                  setError("Failed to remove: " + (err.message || err));
                });
              } }, "Remove")
            ]);
          })),
          h("div", { className: "proposal-footer" }, [
            h("span", { className: "proposal-status" }, prepState.summary),
            h("div", { className: "proposal-actions-row" }, [
              h("button", { className: "primary-button" + (!prepState.canCommit ? " button-disabled" : ""), onClick: function () {
                if (!prepState.canCommit) { setError("Cannot commit: " + prepState.summary); return; }
                setMessage("Committing proposal...");
                var payload = { tasks: planningTasks.map(function (pt) {
                  return {
                    title: pt.title,
                    goal: pt.goal || pt.title,
                    allowedFiles: pt.allowedFiles || [],
                    acceptanceCriteria: pt.acceptanceCriteria || [],
                    commands: pt.commands || [],
                    preferredExecutor: pt.preferredExecutor || "claude-cli",
                    assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli",
                    dependsOn: pt.dependsOn || [],
                    parallelizable: pt.parallelizable || false,
                    priority: pt.priority || "medium",
                  };
                }) };
                fetchJson("/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(payload),
                }).then(function (result) {
                  if (result.ok && result.committed && result.committed.length > 0) {
                    var errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
                    deletePersistedProposalItems(planningTasks).then(function () {
                      setMessage("Created " + String(result.committed.length) + " formal task(s) from proposal." + (errorCount > 0 ? " " + String(errorCount) + " item(s) need attention." : ""));
                      if (errorCount === 0) {
                        setPlanningTasks([]);
                      }
                      if (activeProjectId) {
                        void loadProjectTasks(activeProjectId, null);
                      }
                      void refreshProjectOverview();
                    }).catch(function (cleanupErr) {
                      setMessage("Created " + String(result.committed.length) + " formal task(s), but proposal cleanup needs attention.");
                      setPlanningTasks([]);
                      setError("Proposal cleanup failed: " + (cleanupErr.message || cleanupErr));
                      if (activeProjectId) {
                        void loadProjectTasks(activeProjectId, null);
                      }
                      void refreshProjectOverview();
                    });
                  } else if (result.ok && Array.isArray(result.errors) && result.errors.length > 0) {
                    setError("Commit failed for all proposal items: " + result.errors.map(function (item) { return (item.title || "Untitled") + ": " + item.error; }).join(" | "));
                    if (activeProjectId) {
                      void loadProjectTasks(activeProjectId, null);
                    }
                    void refreshProjectOverview();
                  } else {
                    setError("Commit returned no tasks.");
                  }
                }).catch(function (err) {
                  setError("Commit failed: " + (err.message || err));
                });
              } }, "Commit to Tasks"),
            ])
          ])
        ])
      })(): h("section", { className: "plan-workspace-empty" }, [
          h("div", { className: "plan-workspace-prompt" }, [
            h("div", { className: "plan-prompt-icon" }, "→"),
            h("div", null, [
              h("div", { className: "plan-prompt-title" }, "No proposal yet"),
              h("div", { className: "plan-prompt-hint" }, "Use /plan below to generate a proposal. You can also paste an external plan into the input below and send it."),
              h("div", { className: "proposal-empty-actions" }, [
                h("button", { className: "chip-button", type: "button", onClick: addProposalTask }, "Add Proposal Task")
              ])
            ])
          ])
        ]),
    // Activity section (demoted)
    h("section", { className: "activity-section" }, [
      !project.isTrusted
        ? h("div", { className: "trust-banner" }, [
            h("div", { className: "trust-copy" }, [
              h("strong", null, "Trust this workspace?"),
              h("span", null, "Allow ScopeGuard to read files in this project before it answers with real context.")
            ]),
            h("div", { className: "trust-actions" }, [
              h("button", { className: "primary-button trust-button", onClick: function () { void handleProjectTrust(true); } }, "Trust Workspace"),
              h("button", { className: "secondary-button trust-button", onClick: function () { void handleProjectTrust(false); } }, "Not Now")
            ])
          ])
        : null,
      h("div", { className: "activity-messages" },
        projectThread && Array.isArray(projectThread.messages) && projectThread.messages.length > 0
          ? projectThread.messages.map(function (msg) {
              var actions = Array.isArray(msg.actions) ? msg.actions : [];
              return h("div", { key: msg.id, className: "activity-msg " + (msg.role === "user" ? "user" : "system") }, [
                h("div", { key: "text" }, msg.text),
                actions.length > 0
                  ? h("div", { key: "actions", className: "message-actions" }, actions.map(function (action) {
                      return h("button", {
                        key: action.id || action.intent || action.label,
                        className: "chip-button",
                        type: "button",
                        onClick: function () { void handleProjectMessageAction(action); }
                      }, action.label || action.intent || "Run");
                    }))
                  : null
              ]);
            }).concat(streamingProjectReply
              ? [h("div", { key: "project-stream", className: "activity-msg streaming" }, streamingProjectReply)]
              : [])
          : null
      ),
      h("div", { className: "activity-composer" }, [
        h("textarea", { className: "activity-textarea", value: homeDraftInput, placeholder: "Type /plan to generate a proposal, or send a project note...", onChange: function (event) { setHomeDraftInput(event.target.value); } }),
        h("div", { className: "activity-actions" }, [
          h("button", { className: "chip-button", onClick: function () { void handleHomeSend(); } }, "Send")
        ])
      ])
    ])
  ]);
}

  function renderTaskWorkspace(project, taskDetail, taskContext, thread, draftInput, setDraftInput, handleMessageAction, runTaskAction, handleSend, drawerState, toggleDrawer, editingTaskTitle, taskRenameDraft, setTaskRenameDraft, setEditingTaskTitle, handleTaskRenameSave, selectedContextFilePath, selectedContextFileContent, selectedContextFileLoading, openContextFilePreview, streamingTaskReply, executors, activeRun, handleTaskRun, handleCopyHandoff, handleImportExternalResult, handoffPreviewText, setHandoffPreviewText, lastCompletedRun, handleQueueAssignment, deletingDraft, setDeletingDraft, setMessage, setError, activeProjectId, loadProjectTasks, setView, setActiveTaskId, setTaskDetail, setTaskContext, setThread, externalApiToken) {
    const activeDrawer = drawerState && drawerState.contextOpen
      ? "context"
      : drawerState && drawerState.logsOpen
        ? "logs"
        : null;

    // ── Unified primary task state machine ─────────────────────────────
    function computePrimaryTaskState(td, tc) {
      const isDraft = td.isDraft === true;
      const review = td.latestReviewSummary;
      const run = td.latestRunResult;
      const dispatch = td.dispatchInfo;

      // 0. Hard terminal states (override everything)
      if (td.rawStatus === "approved") {
        return { label: "Approved", type: "approved",
          showQueue: false, showQueued: false, showNoClient: false };
      }
      if (td.rawStatus === "merged" || td.rawStatus === "closed") {
        return { label: "Approved", type: "approved",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 1. Review states (highest priority)
      if (review && review.status === "needs_attention") {
        return { label: "Needs Attention", type: "needs-attention",
          showQueue: false, showQueued: false, showNoClient: false };
      }
      if (review && (review.status === "approved" || review.status === "passed")) {
        return { label: "Approved", type: "approved",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 2. Run completed — awaiting review
      if (run && (run.status === "succeeded" || run.status === "completed") && !(review && review.status === "approved")) {
        return { label: "Awaiting Review", type: "awaiting-review",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 3. Run failed
      if (run && run.status === "failed") {
        return { label: "Run Failed", type: "run-failed",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 4. Run in progress
      if (run && (run.status === "running" || run.status === "in_progress")) {
        return { label: "Running", type: "running",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 5. DepBlocked overrides dispatched — if a task is blocked by dependency,
      //    show that even if it has a pending assignment (the assignment is stale).
      if (td.depBlocked) {
        return { label: "Blocked by Dependency", type: "blocked-by-dependency",
          showQueue: false, showQueued: false, showNoClient: false,
          assignedExecutor: (dispatch && dispatch.assignedExecutor) || td.assignedExecutor || "agent" };
      }

      // 6. Dispatch: queued
      if (dispatch && dispatch.status === "dispatched") {
        return { label: "Queued", type: "queued",
          showQueue: false, showQueued: true, showNoClient: false,
          assignedExecutor: dispatch.assignedExecutor || td.assignedExecutor || "agent" };
      }

      // 7. Dispatch: ready or no_client (no run yet)
      if (dispatch && (dispatch.status === "ready" || dispatch.status === "no_client" || dispatch.status === "idle")) {
        if (isDraft) {
          return { label: "Draft", type: "draft",
            showQueue: false, showQueued: false, showNoClient: false };
        }
        const missing = [];
        if (!tc || !Array.isArray(tc.allowedFiles) || tc.allowedFiles.length === 0) missing.push("scope");
        if (!Array.isArray(td.acceptanceCriteria) || td.acceptanceCriteria.length === 0) missing.push("criteria");
        if (!Array.isArray(td.commands) || td.commands.length === 0) missing.push("commands");
        if (missing.length > 0) {
          return { label: "Needs Setup", type: "needs-setup",
            showQueue: false, showQueued: false, showNoClient: false };
        }
        if (dispatch.status === "ready") {
          return { label: "Ready to Queue", type: "ready-to-queue",
            showQueue: true, showQueued: false, showNoClient: false,
            matchingClient: dispatch.matchingClient,
            assignedExecutor: dispatch.assignedExecutor || td.assignedExecutor };
        }
        if (dispatch.status === "no_client" || dispatch.status === "idle") {
          return { label: "Ready to Queue", type: "ready-to-queue",
            showQueue: false, showQueued: false, showNoClient: true,
            assignedExecutor: dispatch.assignedExecutor || td.assignedExecutor };
        }
      }

      // 7. Draft (fallback)
      if (isDraft) {
        return { label: "Draft", type: "draft",
          showQueue: false, showQueued: false, showNoClient: false };
      }

      // 8. Fallback: raw uiStatus
      return { label: td.uiStatus, type: slugStatus(td.uiStatus),
        showQueue: false, showQueued: false, showNoClient: false };
    }

    const primaryState = computePrimaryTaskState(taskDetail, taskContext);

    // ── Render ─────────────────────────────────────────────────────────
    const captionText = (function () {
  var parts = [];
  if (taskDetail && (taskDetail.assignedExecutor || (taskDetail.dispatchInfo && taskDetail.dispatchInfo.assignedExecutor))) {
    parts.push("Connected route: " + executorDisplayName(executors, (taskDetail.assignedExecutor || (taskDetail.dispatchInfo && taskDetail.dispatchInfo.assignedExecutor))));
  } else {
    parts.push("Project orchestration");
  }
  if (taskDetail.rawStatus === "needs_review") {
    parts.push("execution finished");
    if (taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "ready_for_review") {
      parts.push("reviewer marked ready for approval");
    } else if (taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "needs_attention") {
      parts.push("reviewer requested changes");
    } else if (taskDetail.reviewAssignmentStatus === "pending") {
      parts.push("review queued for " + (taskDetail.assignedExecutor || "agent"));
    } else if (taskDetail.reviewAssignmentStatus === "claimed") {
      parts.push("review in progress");
    } else {
      parts.push("awaiting review/approval");
    }
  } else if (taskDetail.rawStatus === "blocked" && taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "needs_attention") {
    parts.push("reviewer requested changes, task blocked");
  } else if (taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "ready_for_review") {
    parts.push("reviewer marked ready for approval");
  }
  if (taskDetail && taskDetail.depBlocked && !(taskDetail.rawStatus === "approved" || taskDetail.rawStatus === "merged" || taskDetail.rawStatus === "closed")) {
    parts.push("waiting on " + String(taskDetail.dependsOn.length) + " task(s) — must be approved first");
  }
  return parts.join(" — ");
})();

    var executorSection = null;
    if (taskDetail) {
      if (primaryState.showQueue) {
        executorSection = [
          h("span", { key: "dispatch-ready", className: "dispatch-ready-label" }, "Dispatch ready: " + (primaryState.matchingClient ? primaryState.matchingClient.clientName + " (" + executorDisplayName(executors, primaryState.assignedExecutor) + ")" : "connected agent") + " online"),
          h("button", { className: "chip-button queue-button", type: "button", onClick: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            console.log("[scopeguard-web] queue button clicked");
            try { handleQueueAssignment(); }
            catch (e) { console.log("[scopeguard-web] queue button error: " + (e && e.message || e)); setError(e && e.message || "Button handler failed."); }
          }, key: "queue-button" }, "Queue for connected agent")
        ];
      } else if (primaryState.showQueued) {
        executorSection = [
          h("span", { key: "queued-label", className: "dispatch-queued-label" }, "Queued for " + executorDisplayName(executors, primaryState.assignedExecutor) + " - awaiting pickup"),
          h("button", {
            key: "cancel-dispatch",
            className: "ghost-button",
            type: "button",
            style: { marginLeft: "8px", fontSize: "11px" },
            onClick: function (event) {
              if (event && typeof event.preventDefault === "function") event.preventDefault();
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
              console.log("[scopeguard-web] cancel dispatch button clicked");
              try { handleCancelAssignment(); }
              catch (e) { console.log("[scopeguard-web] cancel dispatch error: " + (e && e.message || e)); setError(e && e.message || "Button handler failed."); }
            }
          }, "Cancel dispatch")
        ];
      } else if (taskDetail && taskDetail.dependsOn && taskDetail.dependsOn.length > 0 && !(taskDetail.rawStatus === "approved" || taskDetail.rawStatus === "merged" || taskDetail.rawStatus === "closed")) {
        executorSection = h("div", { className: "dispatch-no-client-action", style: { marginTop: "6px", fontSize: "12px", lineHeight: "1.5", color: "#888" } }, [
          h("span", { style: { fontWeight: 600 } }, "Waiting on " + String(taskDetail.dependsOn.length) + " dependent task(s) to be approved before this can be queued.")
        ]);
      } else if (primaryState.showNoClient) {
        var _isStale = taskDetail && taskDetail.dispatchInfo && taskDetail.dispatchInfo.status === "idle";
        executorSection = [
          h("span", { className: "dispatch-no-client-label" }, _isStale
            ? "Connected session for " + executorDisplayName(executors, primaryState.assignedExecutor) + " is stale — the MCP bridge is no longer sending heartbeats."
            : "No connected agent for " + executorDisplayName(executors, primaryState.assignedExecutor) + " — this project's token is not being used by any active bridge session."),
          _isStale
            ? h("div", { className: "dispatch-no-client-action", style: { marginTop: "6px", fontSize: "12px", lineHeight: "1.5", color: "#555" } }, [
                h("div", { style: { marginBottom: "4px" } }, "The MCP bridge process was running but has gone silent. To reconnect:"),
                h("ol", { style: { margin: "0 0 6px 16px", padding: 0 } }, [
                  h("li", null, "Restart Claude Desktop (or restart the MCP bridge process)."),
                  h("li", null, "Check that the bridge is using this project's token (Settings > Copy MCP Env)."),
                  h("li", null, "Back on this page, queue readiness should reappear within 30 seconds."),
                ]),
                h("div", { style: { marginTop: "4px", display: "flex", gap: "6px", alignItems: "center" } }, [
                  h("button", { className: "chip-button", type: "button", style: { fontSize: "11px" }, onClick: function () {
                    var envBlock = buildProjectMCPEnv(project && project.rootPath ? project.rootPath : "", externalApiToken);
                    void navigator.clipboard.writeText(envBlock).then(function () { setMessage("MCP env config copied."); }).catch(function () { setError("Clipboard access denied."); });
                  } }, "Copy MCP Env"),
                  h("button", { className: "chip-button", type: "button", style: { fontSize: "11px" }, onClick: function () {
                    var jsonBlock = buildProjectMCPJsonSnippet(project && project.rootPath ? project.rootPath : "", externalApiToken);
                    void navigator.clipboard.writeText(jsonBlock).then(function () { setMessage("Claude Desktop config snippet copied. Paste into claude_desktop_config.json."); }).catch(function () { setError("Clipboard access denied."); });
                  } }, "Copy Claude Desktop Config"),
                ])
              ])
            : h("div", { className: "dispatch-no-client-action", style: { marginTop: "6px", fontSize: "12px", lineHeight: "1.5", color: "#555" } }, [
                h("div", { style: { marginBottom: "4px" } }, "To connect Claude Desktop / MCP bridge to this project:"),
                h("ol", { style: { margin: "0 0 6px 16px", padding: 0 } }, [
                  h("li", null, "Copy the project env config below."),
                  h("li", null, "In Claude Desktop, add a new MCP server using the env vars or the JSON snippet."),
                  h("li", null, "Restart Claude Desktop and come back here — readiness should appear within 30 seconds."),
                ]),
                h("div", { style: { background: "#f5f5f5", padding: "6px 8px", borderRadius: "4px", fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap", marginBottom: "6px" } }, [
                  "SCOPEGUARD_BASE_URL=http://127.0.0.1:3737",
                  h("br"),
                  "SCOPEGUARD_TOKEN=" + String(externalApiToken || "<token>"),
                  h("br"),
                  "SCOPEGUARD_EXECUTOR_ID=claude-cli"
                ]),
                h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [
                  h("button", { className: "chip-button", type: "button", style: { fontSize: "11px" }, onClick: function () {
                    var envBlock = buildProjectMCPEnv(project && project.rootPath ? project.rootPath : "", externalApiToken);
                    void navigator.clipboard.writeText(envBlock).then(function () { setMessage("MCP env config copied."); }).catch(function () { setError("Clipboard access denied."); });
                  } }, "Copy MCP Env"),
                  h("button", { className: "chip-button", type: "button", style: { fontSize: "11px" }, onClick: function () {
                    var jsonBlock = buildProjectMCPJsonSnippet(project && project.rootPath ? project.rootPath : "", externalApiToken);
                    void navigator.clipboard.writeText(jsonBlock).then(function () { setMessage("Claude Desktop config snippet copied."); }).catch(function () { setError("Clipboard access denied."); });
                  } }, "Copy Claude Desktop Config"),
                ])
              ])
        ];
      }
    }

    var taskActionButtons = [];
    if (taskDetail) {
      if (taskDetail.isDraft === true) {
        console.log("[scopeguard-web] render delete draft button: id=" + taskDetail.id + " isDraft=" + taskDetail.isDraft + " deletingDraft=" + deletingDraft);
        taskActionButtons.push(h("button", {
          key: "delete-draft",
          className: "ghost-button" + (deletingDraft ? " button-disabled" : ""),
          type: "button",
          disabled: deletingDraft,
          onClick: async function (event) {
            console.log("[scopeguard-web] delete draft ENTER id=" + taskDetail.id + " deletingDraft=" + deletingDraft + " isDraft=" + taskDetail.isDraft);
            if (deletingDraft) { console.log("[scopeguard-web] delete draft: early return — already deleting"); return; }
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            try {
              setDeletingDraft(true);
              setMessage("Deleting draft...");
              var deleteUrl = "/api/desktop/tasks/draft/" + encodeURIComponent(taskDetail.id);
              console.log("[scopeguard-web] delete draft: id=" + taskDetail.id + " url=" + deleteUrl + " gitRoot=" + (project ? project.rootPath : "?"));
              var deleteResult = await fetchJson(deleteUrl, { method: "DELETE" });
              console.log("[scopeguard-web] delete draft: FETCH OK response ok=" + deleteResult.ok + " taskId=" + (deleteResult.taskId || "?"));
              setMessage("Draft deleted. Returning to project...");
              if (activeProjectId) {
                console.log("[scopeguard-web] delete draft: refreshing project " + activeProjectId);
                await loadProjectTasks(activeProjectId, null);
              }
              setView("home");
              setActiveTaskId(null);
              setTaskDetail(null);
              setTaskContext(null);
              setThread(null);
              setDeletingDraft(false);
              setMessage("Draft deleted.");
              console.log("[scopeguard-web] delete draft: done, view=home");
            } catch (err) {
              var errMsg = err && err.message || String(err || "");
              console.log("[scopeguard-web] delete draft ERROR: " + errMsg);
              if (errMsg.indexOf("NOT_FOUND") >= 0) {
                console.log("[scopeguard-web] delete draft: stale (file not found), refreshing");
                setMessage("Draft no longer exists. Refreshed task list.");
                setDeletingDraft(false);
                if (activeProjectId) { try { await loadProjectTasks(activeProjectId, null); } catch (e2) { /* ignore refresh errors */ } }
                setView("home");
                setActiveTaskId(null);
                setTaskDetail(null);
                setTaskContext(null);
                setThread(null);
              } else {
                setDeletingDraft(false);
                setError("Delete failed: " + errMsg);
              }
            }
          }
        }, deletingDraft ? "Deleting..." : "Delete draft"));
      } else {
        // ── Consolidated Approve visibility diagnostic ──
        var _latestReviewStatus = taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status;
        var _reviewReady =
          taskDetail.rawStatus !== "approved" &&
          taskDetail.rawStatus !== "blocked" &&
          taskDetail.rawStatus !== "closed" &&
          (
            primaryState.type === "awaiting-review" ||
            taskDetail.rawStatus === "needs_review" ||
            _latestReviewStatus === "ready_for_review" ||
            taskDetail.reviewStatus === "ready_for_review"
          );
        console.log("[scopeguard-web] approve visibility", {
          id: taskDetail.id,
          rawStatus: taskDetail.rawStatus,
          primaryStateType: primaryState.type,
          latestReviewStatus: _latestReviewStatus,
          reviewStatus: taskDetail.reviewStatus,
          reviewReady: _reviewReady,
        });
        if (_reviewReady) {
          taskActionButtons.push(h("button", {
            key: "approve",
            className: "chip-button",
            type: "button",
            onClick: function () { console.log("[scopeguard-web] approve clicked: " + (taskDetail ? taskDetail.id : "?")); setMessage("Approving task..."); void runTaskAction("approve", { userText: "Approve this step and continue." }); }
          }, "Approve"));
          // Dev-only: simulate reviewer rejecting the task
          taskActionButtons.push(h("button", {
            key: "simulate-needs-attention",
            className: "ghost-button",
            type: "button",
            style: { fontSize: "11px", opacity: "0.65" },
            onClick: async function () {
              console.log("[scopeguard-web] simulate-needs-attention: taskId=" + taskDetail.id);
              setMessage("Simulating needs_attention...");
              try {
                var simResult = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(taskDetail.id) + "/simulate-needs-attention", { method: "POST" });
                console.log("[scopeguard-web] simulate-needs-attention: ok=" + simResult.ok + " taskId=" + simResult.taskId);
                setMessage("Reviewer feedback simulated: needs_attention. Task is now blocked.");
                // Refresh task detail directly (refreshCurrentTask is not in scope here)
                try {
                  var refDetail = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(taskDetail.id));
                  if (refDetail.task) { setTaskDetail(refDetail.task); }
                  var refCtx = await fetchJson("/api/desktop/tasks/" + encodeURIComponent(taskDetail.id) + "/context");
                  if (refCtx.context) { setTaskContext(refCtx.context); }
                } catch (refErr) { /* non-fatal */ }
                // Refresh sidebar task list so it also shows the new state
                if (activeProjectId) {
                  loadProjectTasks(activeProjectId, taskDetail.id).catch(function (listErr) { /* non-fatal */ });
                }
              } catch (simErr) {
                var simMsg = simErr && simErr.message || String(simErr || "");
                console.log("[scopeguard-web] simulate-needs-attention ERROR: " + simMsg);
                setError("Simulate failed: " + simMsg);
              }
            }
          }, "Simulate Needs Attention (Test)"));
        } else if (taskDetail.rawStatus === "blocked" && taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "needs_attention") {
          taskActionButtons.push(h("button", {
            key: "address-review-feedback",
            className: "chip-button",
            type: "button",
          onClick: function () { void runTaskAction("refine", { userText: "Address review feedback: " + (taskDetail.latestReviewSummary.suggestion || "") + " [revise task based on feedback]" }); }
          }, "Address Review Feedback"));
        } else if (taskDetail.rawStatus !== "closed" && taskDetail.rawStatus !== "approved" && taskDetail.rawStatus !== "blocked") {
          taskActionButtons.push(h("button", {
            key: "review",
            className: "ghost-button",
            type: "button",
            onClick: function () { void runTaskAction("review", { userText: "Review the current task state and summarize what changed." }); }
          }, "Review"));
        }
        if (taskDetail.rawStatus !== "closed") {
          taskActionButtons.push(h("button", {
            key: "archive-task",
            className: "ghost-button",
            type: "button",
            onClick: function () { void runTaskAction("archive", { userText: "Archive this task." }); }
          }, "Archive task"));
        }
      }
      console.log("[scopeguard-web] taskActionButtons final:", taskActionButtons.map(function (b) {
        if (b && b.props) { return b.props.children || "?"; }
        return String(b);
      }));
    }

    return h("div", { className: "workspace-shell" }, [
      h("section", { className: "task-header-card" }, [
        h("div", { className: "task-header-copy" }, [
          h("div", { className: "crumbs" }, project ? project.name : taskDetail.projectId),
          renderEditableTitle(taskDetail.title, editingTaskTitle, taskRenameDraft, setTaskRenameDraft, setEditingTaskTitle, handleTaskRenameSave, "Rename task"),
          h("div", { className: "title-caption-row" }, [
            h("span", { className: "status-badge " + (primaryState.type === "draft" ? "status-draft" : primaryState.type === "ready-to-queue" ? "status-ready-to-queue" : primaryState.type === "awaiting-review" ? "status-awaiting-review" : primaryState.type === "approved" ? "status-approved" : primaryState.type === "needs-attention" ? "status-needs-attention" : primaryState.type === "run-failed" ? "status-run-failed" : primaryState.type === "running" ? "status-running" : primaryState.type === "queued" ? "status-queued" : primaryState.type === "needs-setup" ? "status-needs-setup" : "status-" + slugStatus(taskDetail.uiStatus)) }, primaryState.label),
            h("span", { className: "title-caption" }, captionText)
          ]),
          executorSection
            ? h("div", { className: "executor-buttons", style: { marginTop: "6px" } }, Array.isArray(executorSection) ? executorSection : [executorSection])
            : null,
          taskActionButtons.length > 0
            ? h("div", { className: "executor-buttons", style: { marginTop: "8px" } }, taskActionButtons)
            : null
        ])
      ]),
      handoffPreviewText
        ? h("div", { className: "handoff-preview-panel" }, [
            h("div", { className: "handoff-preview-header" }, [
              "Task Handoff",
              h("button", {
                className: "chip-button",
                style: { marginLeft: "8px", fontSize: "11px" },
                onClick: function () { setHandoffPreviewText(""); }
              }, "Close")
            ]),
            h("textarea", {
              className: "handoff-preview-textarea",
              readOnly: true,
              rows: 20,
              value: handoffPreviewText,
              onClick: function (e) { e.currentTarget.select(); }
            })
          ])
        : null,
      h("div", { className: "task-layout" }, [
        h("section", { className: "chat-card task-chat-card conversation-shell" }, [
          h("div", { className: "activity-section-label" }, "Activity"),
          h("div", { className: "messages" },
            thread && Array.isArray(thread.messages) && thread.messages.length > 0
              ? thread.messages.map(function (msg) {
                  var msgKind = msg.kind || "text";
                  var msgType = msg.role === "user" ? "user-note" : msgKind === "text" ? "system" : msgKind.replace(/_/g, "-");
                  var msgLabel = msg.role === "user" ? "You" : msg.kind === "review" ? "Review" : msg.kind === "handoff" ? "Agent" : msgKind === "summary" ? "Summary" : msgKind === "validation" ? "Validation" : msgKind === "approval_request" || msgKind === "approval_result" ? "Approval" : "";
                  return h("div", {
                    key: msg.id,
                    className: "message message-" + msgType
                  }, [
                    msgLabel ? h("div", { key: "message-header", className: "message-header" }, msgLabel) : null,
                    h("div", { key: "message-text", className: "message-text" }, msg.text),
                    Array.isArray(msg.actions) && msg.actions.length > 0
                      ? h("div", { key: "message-actions", className: "message-actions" }, msg.actions.map(function (action) {
                          return h("button", {
                            key: action.id || action.intent || action.label,
                            className: "chip-button",
                            type: "button",
                            onClick: function () { void handleMessageAction(action); }
                          }, action.label || action.intent || "Run");
                        }))
                      : null
                  ]);
                }).concat(streamingTaskReply
                  ? [h("div", { key: "task-stream", className: "message system streaming" }, [
                      h("div", { key: "task-stream-text", className: "message-text" }, streamingTaskReply)
                    ])]
                  : [])
              : [h("div", { key: "empty", className: "message system" }, [
                  h("div", { key: "empty-text", className: "message-text" }, "")
                ])]
          ),
          h("div", { className: "composer" }, [
            h("div", { className: "composer-row" }, [
              h("div", { className: "composer-shell" }, [
                h("div", { className: "composer-section-label" }, "Follow-up"),
                h("textarea", {
                  className: "composer-textarea",
                  value: draftInput,
                  placeholder: taskDetail && taskDetail.assignedExecutor
                    ? "Add an instruction for the agent..."
                    : "Add a note or instruction for this task...",
                  onChange: function (event) { setDraftInput(event.target.value); }
                }),
                h("div", { className: "composer-footer" }, [
                  h("button", {
                    className: "composer-send-button",
                    onClick: function () {
                      void handleSend();
                    }
                  }, "Send")
                ])
              ])
            ])
          ])
        ]),
        (activeRun || lastCompletedRun || (taskDetail && taskDetail.latestRunResult))
          ? (function () {
              // Priority: activeRun > matching lastCompletedRun > latestRunResult > lastCompletedRun
              var run = activeRun;
              var isLive = !!activeRun;
              if (!run && lastCompletedRun && taskDetail && taskDetail.latestRunResult && lastCompletedRun.runId === taskDetail.latestRunResult.runId) {
                run = lastCompletedRun;
              }
              if (!run && taskDetail && taskDetail.latestRunResult) {
                run = taskDetail.latestRunResult;
              }
              if (!run) { run = lastCompletedRun; }
              if (!run || run.launchMode !== "connected") { return null; }
              return h("aside", { key: "run-panel", className: "drawer-panel run-panel" }, [
                h("div", { className: "drawer-panel-header" }, [
                  h("strong", null, "Latest Execution" + (run && run.launchMode === "connected" ? " - via " + (run.executorId === "codex-cli" ? "Codex CLI" : "Claude CLI") : "")),
                  h("span", { className: "run-status-badge run-status-" + run.status }, run.status),
                  run.launchMode === "connected" ? h("span", { className: "run-status-badge", style: { background: "#eef0f4", color: "#5f6877" } }, "Connected") : null
                ]),
                (run.stdout || run.stderr)
                  ? h("div", { className: "drawer-section" }, [
                      h("div", { className: "drawer-section-title" }, "Output"),
                      h("pre", { className: "run-output" }, (run.stdout || "") + (run.stderr ? "\n[stderr]\n" + run.stderr : ""))
                    ])
                  : isLive
                    ? h("div", { className: "drawer-section" }, [
                        h("div", { className: "drawer-empty" }, "Waiting for output...")
                      ])
                    : null,
                run.exitCode !== null && run.exitCode !== undefined
                  ? h("div", { className: "drawer-section" }, [
                      h("div", { className: "drawer-section-title" }, "Exit code"),
                      h("div", { className: "drawer-item" }, String(run.exitCode))
                    ])
                  : null,
                run.resultSummary
                  ? h("div", { className: "drawer-section" }, [
                      h("div", { className: "drawer-section-title" }, "Result"),
                      h("div", { className: "drawer-item" }, run.resultSummary)
                    ])
                  : null,
                run.changedFiles && run.changedFiles.length > 0
                  ? h("div", { className: "drawer-section" }, [
                      h("div", { className: "drawer-section-title" }, "Changed files"),
                      h("div", { className: "drawer-file-list" }, run.changedFiles.map(function (f) {
                        return h("div", { key: f, className: "drawer-item" }, f);
                      }))
                    ])
                  : null,
                !isLive && taskDetail && taskDetail.latestReviewSummary
                  ? h("div", { className: "drawer-section" }, [
                      (function () { var revLabel = "Review"; if (taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "ready_for_review") { revLabel += " — reviewer marked ready for approval"; } else if (taskDetail.latestReviewSummary && taskDetail.latestReviewSummary.status === "needs_attention") { revLabel += " — reviewer requested changes"; } else if (taskDetail.reviewAssignmentStatus === "pending") { revLabel += " — review queued, awaiting pickup"; } else if (taskDetail.reviewAssignmentStatus === "claimed") { revLabel += " — review in progress"; } else { revLabel += " — execution finished, awaiting review/approval"; } return h("div", { className: "drawer-section-title" }, revLabel); })(),
                      h("div", { className: "drawer-item review-item-" + (taskDetail.latestReviewSummary.status === "ready_for_review" ? "ok" : "fail") }, taskDetail.latestReviewSummary.suggestion),
                      h("div", { className: "drawer-section-title", style: { marginTop: "4px" } }, "Files changed: " + taskDetail.latestReviewSummary.changedFileCount + (taskDetail.latestReviewSummary.hasAcceptanceCriteria ? " | Has criteria" : "") + (taskDetail.latestReviewSummary.hasCommands ? " | Has commands" : ""))
                    ])
                  : null
              ]);
            })()
          : null,
        activeDrawer
          ? renderTaskDrawer(activeDrawer, taskDetail, taskContext, selectedContextFilePath, selectedContextFileContent, selectedContextFileLoading, openContextFilePreview)
          : null,
        h("div", { className: "drawer-tabs" }, [
          h("button", {
            className: "drawer-tab" + (activeDrawer === "context" ? " active" : ""),
            onClick: function () {
              void toggleDrawer("context");
            }
          }, [
            h("span", { key: "label", className: "drawer-tab-label" }, "Context"),
            h("span", { key: "meta", className: "drawer-tab-meta" }, taskContext && Array.isArray(taskContext.allowedFiles) && taskContext.allowedFiles.length > 0
              ? String(taskContext.allowedFiles.length) + " rules"
              : "Task scope")
          ]),
          h("button", {
            className: "drawer-tab" + (activeDrawer === "logs" ? " active" : ""),
            onClick: function () {
              void toggleDrawer("logs");
            }
          }, [
            h("span", { key: "label", className: "drawer-tab-label" }, "Logs"),
            h("span", { key: "meta", className: "drawer-tab-meta" }, taskContext && taskContext.activitySummary
              ? String(taskContext.activitySummary.eventCount) + " events"
              : "Activity")
          ])
        ])
      ])
    ]);
  }

  function renderTaskDrawer(activeDrawer, taskDetail, taskContext, selectedContextFilePath, selectedContextFileContent, selectedContextFileLoading, openContextFilePreview) {
    if (activeDrawer === "context") {
      const allowed = taskContext && Array.isArray(taskContext.allowedFiles) ? taskContext.allowedFiles : [];
      const forbidden = taskContext && Array.isArray(taskContext.forbiddenFiles) ? taskContext.forbiddenFiles : [];
      const referenceFiles = taskContext && Array.isArray(taskContext.referenceFiles) ? taskContext.referenceFiles : [];

      return h("aside", { className: "drawer-panel" }, [
        h("div", { className: "drawer-panel-header" }, [
          h("strong", null, "Context"),
          h("span", null, taskDetail.uiStatus)
        ]),
        h("div", { className: "drawer-section" }, [
          h("div", { className: "drawer-section-title" }, "Reference files"),
          referenceFiles.length > 0
            ? h("div", { className: "drawer-file-list" }, referenceFiles.map(function (item, index) {
                return h("button", {
                  key: "reference-" + index,
                  className: "drawer-file-button" + (selectedContextFilePath === item.path ? " active" : ""),
                  onClick: function () {
                    void openContextFilePreview(item.path);
                  }
                }, [
                  h("span", { key: "label", className: "drawer-file-label" }, item.label),
                  h("span", { key: "path", className: "drawer-file-path" }, item.path)
                ]);
              }))
            : h("div", { className: "drawer-empty" }, "No reference docs for this task yet.")
        ]),
        h("div", { className: "drawer-section" }, [
          h("div", { className: "drawer-section-title" }, "Preview"),
          h("div", { className: "drawer-preview-shell" }, [
            h("div", { className: "drawer-preview-header" }, selectedContextFilePath || "Select a file"),
            h("pre", { className: "drawer-preview-content" }, selectedContextFileLoading
              ? "Loading..."
              : selectedContextFileContent || "Choose a reference file to preview it here.")
          ])
        ]),
        h("div", { className: "drawer-section" }, [
          h("div", { className: "drawer-section-title" }, "Allowed files"),
          allowed.length > 0
            ? h("div", { className: "drawer-list" }, allowed.map(function (item, index) {
                return h("div", { key: "allowed-" + index, className: "drawer-item" }, item);
              }))
            : h("div", { className: "drawer-empty" }, "No explicit allowed files yet.")
        ]),
        h("div", { className: "drawer-section" }, [
          h("div", { className: "drawer-section-title" }, "Forbidden files"),
          forbidden.length > 0
            ? h("div", { className: "drawer-list" }, forbidden.map(function (item, index) {
                return h("div", { key: "forbidden-" + index, className: "drawer-item" }, item);
              }))
            : h("div", { className: "drawer-empty" }, "No explicit forbidden files.")
        ])
      ]);
    }

    return h("aside", { className: "drawer-panel" }, [
      h("div", { className: "drawer-panel-header" }, [
        h("strong", null, "Logs"),
        h("span", null, taskContext && taskContext.activitySummary ? String(taskContext.activitySummary.eventCount) + " events" : "Activity")
      ]),
      h("div", { className: "drawer-section" }, [
        h("div", { className: "drawer-section-title" }, "Latest event"),
        h("div", { className: "drawer-item" }, taskContext && taskContext.activitySummary && taskContext.activitySummary.lastEvent
          ? taskContext.activitySummary.lastEvent
          : "No activity recorded yet.")
      ]),
      h("div", { className: "drawer-section" }, [
        h("div", { className: "drawer-section-title" }, "Validation"),
        h("div", { className: "drawer-item" }, taskContext && taskContext.validationSummary
          ? "Status: " + taskContext.validationSummary.latestStatus
          : "No validation status yet.")
      ])
    ]);
  }

  function getTaskReadiness(taskDetail, taskContext) {
    if (taskDetail.isDraft) {
      return {
        label: "Draft",
        title: "Draft",
        message: "Describe the task goal, scope, and constraints here.",
        setupHint: "Draft"
      };
    }

    const missing = [];
    if (!taskContext || !Array.isArray(taskContext.allowedFiles) || taskContext.allowedFiles.length === 0) {
      missing.push("scope");
    }
    if (!Array.isArray(taskDetail.acceptanceCriteria) || taskDetail.acceptanceCriteria.length === 0) {
      missing.push("criteria");
    }
    if (!Array.isArray(taskDetail.commands) || taskDetail.commands.length === 0) {
      missing.push("commands");
    }

    if (missing.length === 0) {
      return {
        label: "Ready to queue",
        title: "Ready",
        message: "This task already has scope, acceptance criteria, and verification commands. It can be queued for a connected agent.",
        setupHint: "Ready"
      };
    }

    return {
      label: "Needs setup",
      title: "Needs setup",
      message: "Add the missing details here: " + missing.join(", ") + ".",
      setupHint: "Missing " + String(missing.length)
    };
  }

  function summarizeTask(taskDetail, taskContext) {
    const allowed = taskContext && Array.isArray(taskContext.allowedFiles) && taskContext.allowedFiles.length > 0
      ? taskContext.allowedFiles.join(", ")
      : "No explicit file scope found.";
    const validation = taskContext && taskContext.validationSummary
      ? taskContext.validationSummary.latestStatus
      : "unknown";

    return [
      "Current task summary:",
      "",
      "Goal: " + (taskDetail.description || taskDetail.title),
      "Status: " + taskDetail.uiStatus,
      "Allowed files: " + allowed,
      "Validation: " + validation
    ].join("\n");
  }

  function explainConstraints(taskDetail, taskContext) {
    const allowed = taskContext && Array.isArray(taskContext.allowedFiles) && taskContext.allowedFiles.length > 0
      ? taskContext.allowedFiles.join(", ")
      : "No explicit allowed files found.";
    const forbidden = taskContext && Array.isArray(taskContext.forbiddenFiles) && taskContext.forbiddenFiles.length > 0
      ? taskContext.forbiddenFiles.join(", ")
      : "No explicit forbidden files found.";

    return [
      "Current task constraints:",
      "",
      "Task: " + taskDetail.title,
      "Allowed files: " + allowed,
      "Forbidden files: " + forbidden,
      "Keep changes task-focused and avoid unrelated edits."
    ].join("\n");
  }

  function latestProjectGoal(projectThread, fallbackText) {
    if (projectThread && Array.isArray(projectThread.messages)) {
      for (let i = projectThread.messages.length - 1; i >= 0; i -= 1) {
        const message = projectThread.messages[i];
        if (message && message.role === "user" && typeof message.text === "string" && message.text.trim()) {
          return message.text.trim();
        }
      }
    }

    return String(fallbackText || "").trim();
  }

  function getDesktopApi() {
    return window.scopeguardDesktop && typeof window.scopeguardDesktop.openProjectFolder === "function"
      ? window.scopeguardDesktop
      : null;
  }

  function buildUserMessage(text) {
    return {
      id: "m-" + Date.now() + "-user",
      role: "user",
      kind: "text",
      text: text,
      createdAt: new Date().toISOString()
    };
  }

  function buildScopeGuardLocalMessage(kind, text, actions) {
    return {
      id: "m-" + Date.now() + "-sg",
      role: "scopeguard",
      kind: kind,
      text: text,
      createdAt: new Date().toISOString(),
      actions: actions
    };
  }

  function formatRuntimeDate(isoString) {
    if (!isoString) return "?";
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      const pad = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } catch {
      return isoString;
    }
  }

  function actionLabel(action) {
    switch (action) {
      case "handoff":
        return "Handoff";
      case "review":
        return "Review";
      case "approve":
        return "Approval";
      case "summary":
        return "Summary";
      case "constraints":
        return "Constraints";
      case "refine":
        return "Refinement";
      case "update-details":
        return "Task details";
      case "home":
        return "Project conversation";
      case "initialize":
        return "Initialization";
      case "git-init":
        return "Git initialization";
      case "open-folder":
        return "Open folder";
      case "rename-project":
        return "Project rename";
      case "rename-task":
        return "Task rename";
      default:
        return "Action";
    }
  }

  // ── Structured plan detection helper (pure) ──
  // Returns array of { title, goal, ... } if text looks like JSON or Markdown plan, null otherwise.
  function tryParseStructuredPlan(rawText) {
    var text = String(rawText || "").trim();
    if (!text) return null;
    // Try JSON
    try {
      var parsed = JSON.parse(text);
      var arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null);
      if (arr && arr.length > 0) {
        return arr.map(function (item, idx) {
          var title = String(item.title || item.name || "Task " + (idx + 1)).trim();
          return {
            id: item.id || "IMPORTED-" + Date.now() + "-" + String(idx),
            title: title,
            goal: String(item.goal || item.description || title).trim(),
            allowedFiles: arrayOrEmpty(item.allowedFiles || item.files),
            acceptanceCriteria: arrayOrEmpty(item.acceptanceCriteria || item.criteria),
            commands: arrayOrEmpty(item.commands),
            preferredExecutor: item.preferredExecutor || item.assignedExecutor || "claude-cli",
            assignedExecutor: item.assignedExecutor || item.preferredExecutor || "claude-cli",
            dependsOn: arrayOrEmpty(item.dependsOn || item.dependencies),
            parallelizable: item.parallelizable === true,
            priority: ["high", "medium", "low"].indexOf(item.priority) >= 0 ? item.priority : "medium",
          };
        });
      }
    } catch { /* not JSON */ }
    // Try Markdown / structured text
    var lines = text.split(/\r?\n/);
    var hasTaskLine = lines.some(function (line) {
      var t = line.trim();
      return /^[-*\d]+[.)]\s+/.test(t) || /^#{2,6}\s+/.test(t);
    });
    if (!hasTaskLine) return null;
    // Parse using the same logic as parsePlanTextToTasks
    var tasks = [];
    var current = null;
    function pushCurrent() { if (current && current.title) { tasks.push(current); } current = null; }
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var taskMatch = t.match(/^(?:[-*]\s+|\d+[.)]\s+)(?:\[[^\]]+\]\s*)?(.+)$/);
      var headingMatch = t.match(/^#{2,6}\s+(.+)$/);
      if (taskMatch || headingMatch) {
        pushCurrent();
        var title = (taskMatch ? taskMatch[1] : headingMatch[1]).replace(/^\*\*|\*\*$/g, "").trim();
        current = { title: title, goal: title, acceptanceCriteria: [], allowedFiles: [], commands: [] };
        return;
      }
      if (!current) return;
      var filesMatch = t.match(/^(?:files?|allowedFiles?|scope)\s*:\s*(.+)$/i);
      var criteriaMatch = t.match(/^(?:criteria|acceptanceCriteria|acceptance)\s*:\s*(.+)$/i);
      var commandsMatch = t.match(/^(?:commands?|verify|verification)\s*:\s*(.+)$/i);
      var execMatch = t.match(/^(?:executor|preferredExecutor|assignedExecutor)\s*:\s*(.+)$/i);
      if (filesMatch) { current.allowedFiles = filesMatch[1].split(/[,;]/).map(function (s) { return s.trim(); }).filter(Boolean); }
      else if (criteriaMatch) { current.acceptanceCriteria.push(criteriaMatch[1].trim()); }
      else if (commandsMatch) { current.commands.push(commandsMatch[1].replace(/^`|`$/g, "").trim()); }
      else if (execMatch) { current.preferredExecutor = /codex/i.test(execMatch[1]) ? "codex-cli" : "claude-cli"; }
      else { current.goal = current.goal === current.title ? t : current.goal + " " + t; }
    });
    pushCurrent();
    return tasks.length > 0 ? tasks.map(function (pt, idx) { return { id: pt.id || "IMPORTED-" + Date.now() + "-" + String(idx), title: pt.title, goal: pt.goal, allowedFiles: pt.allowedFiles || [], acceptanceCriteria: pt.acceptanceCriteria || [], commands: pt.commands || [], preferredExecutor: pt.preferredExecutor || "claude-cli", assignedExecutor: pt.assignedExecutor || pt.preferredExecutor || "claude-cli", dependsOn: pt.dependsOn || [], parallelizable: pt.parallelizable || false, priority: pt.priority || "medium" }; }) : null;
  }
  function arrayOrEmpty(val) { return Array.isArray(val) ? val.map(function (s) { return String(s).trim(); }).filter(Boolean) : []; }

  function detectProjectIntentV2(text) {
    const lower = String(text || "").toLowerCase();

    if (
      lower.includes("plan")
      || lower.includes("planning")
      || lower.includes("break this down")
      || lower.includes("break it down")
      || lower.includes("split into tasks")
      || lower.includes("task plan")
      || lower.includes("first version structure")
      || lower.includes("create the structure")
      || lower.includes("create readme")
      || lower.includes("create initial")
      || lower.includes("create docs")
      || lower.includes("create examples")
      || lower.includes("first draft files")
      || lower.includes("first draft")
      || lower.includes("bootstrap docs")
      || lower.includes("bootstrap examples")
      || lower.includes("bootstrap")
      || lower.includes("initialize")
      || lower.includes("scaffold")
      || lower.includes("skeleton")
      || lower.includes("repo structure")
      || lower.includes("first pass")
      || lower.includes("initial setup")
      || lower.includes("initial files")
      || lower.includes("初版内容")
      || lower.includes("第一版文档")
      || lower.includes("第一版")
      || lower.includes("创建") && (lower.includes("readme") || lower.includes("docs") || lower.includes("examples") || lower.includes("文件"))
      || lower.includes("目录结构")
      || lower.includes("初始化")
      || lower.includes("规划")
      || lower.includes("拆分任务")
      || lower.includes("拆成任务")
      || lower.includes("任务规划")
      || lower.includes("第一版结构")
      || lower.includes("项目结构")
      || lower.includes("repo 结构")
      || lower.includes("仓库结构")
    ) {
      return { type: "plan-project" };
    }

    if (
      lower.includes("start task")
      || lower.includes("create task")
      || lower.includes("new task")
      || lower.includes("turn this into a task")
      || lower.includes("task conversation")
      || lower.includes("开始任务")
      || lower.includes("创建任务")
      || lower.includes("新建任务")
      || lower.includes("拆成任务")
      || lower.includes("转成任务")
    ) {
      return { type: "start-task-conversation" };
    }

    if (
      lower.includes("review active tasks")
      || lower.includes("summarize active tasks")
      || lower.includes("show active tasks")
      || lower.includes("当前任务")
      || lower.includes("活动任务")
      || lower.includes("任务列表")
      || lower.includes("总结任务")
    ) {
      return { type: "review-active-tasks" };
    }

    if (
      lower.includes("blocker")
      || lower.includes("blocked")
      || lower.includes("risk")
      || lower.includes("卡住")
      || lower.includes("阻塞")
      || lower.includes("风险")
      || lower.includes("需要 review")
    ) {
      return { type: "show-blockers" };
    }

    return { type: "summary" };
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    var now = Date.now();
    var then = Date.parse(dateStr);
    if (!then) return "";
    var diff = Math.floor((now - then) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function slugStatus(status) {
    return String(status || "")
      .toLowerCase()
      .replace(/\s+/g, "-");
  }

  function executorDisplayName(executors, id) {
    if (!executors || !Array.isArray(executors)) return id;
    const ex = executors.find(function (e) { return e.id === id; });
    return ex && ex.displayName ? ex.displayName : id;
  }

  // Returns true for external executor API paths that require Bearer token auth.
  function shouldAttachExternalToken(url) {
    if (url.includes("/api/desktop/external/")) return true;
    if (url.includes("/handoff")) return true;
    if (url.includes("/external-run/start")) return true;
    if (url.includes("/external-run/finish")) return true;
    if (url.includes("/external-review")) return true;
    return false;
  }

  async function fetchJson(url, options) {
    const headers = Object.assign({}, (options && options.headers) || {});
    const externalApiToken = options && options.externalApiToken ? options.externalApiToken : "";
    if (externalApiToken && shouldAttachExternalToken(url)) {
      headers.authorization = "Bearer " + externalApiToken;
    }
    const requestOptions = Object.assign({}, options || {});
    delete requestOptions.externalApiToken;
    const response = await fetch(url, Object.assign({}, requestOptions, { headers }));
    const body = await response.json().catch(function () { return {}; });

    if (!response.ok || body.ok === false) {
      const message = body && body.code
        ? body.code + ": " + (body.message || response.statusText)
        : body && body.message
          ? body.message
          : response.statusText;
      throw new Error(message);
    }

    return body;
  }

  async function streamAssistant(url, payload, onChunk) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok || !response.body) {
      const body = await response.json().catch(function () { return {}; });
      const message = body && body.code
        ? body.code + ": " + (body.message || response.statusText)
        : body && body.message
          ? body.message
          : response.statusText;
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let donePayload = null;
    let fullReply = "";

    function handleEventData(data) {
      if (data.error) {
        throw new Error(data.message || "Stream request failed.");
      }
      if (typeof data.chunk === "string" && data.chunk) {
        fullReply += data.chunk;
        onChunk(data.chunk);
      }
      if (data.done) {
        donePayload = data;
      }
    }

    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventText of events) {
        const line = eventText.split("\n").find(function (entry) {
          return entry.startsWith("data: ");
        });
        if (!line) {
          continue;
        }

        handleEventData(JSON.parse(line.slice(6)));
      }
    }

    if (buffer.trim()) {
      buffer.split("\n").forEach(function (entry) {
        if (entry.startsWith("data: ")) {
          handleEventData(JSON.parse(entry.slice(6)));
        }
      });
    }

    return donePayload || (fullReply.trim() ? { reply: fullReply.trim() } : {});
  }

  ReactDOM.createRoot(document.getElementById("app")).render(h(App));
})();
