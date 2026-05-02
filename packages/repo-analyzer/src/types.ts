export type ProjectMap = {
  projectId: string;
  generatedAt: string;
  rootPath: string;
  summary: string;
  stack: {
    languages: string[];
    frameworks: string[];
    packageManager: string;
  };
  areas: CodeArea[];
  dependencyGraph: DependencyEdge[];
};

export type CodeArea = {
  id: string;
  name: string;
  paths: string[];
  summary: string;
  dependencies: string[];
  relatedTests: string[];
  riskLevel: "low" | "medium" | "high";
};

export type DependencyEdge = {
  from: string;
  to: string;
  type: "import" | "require" | "dynamic" | "unknown";
};

export type ProjectConfig = {
  projectId: string;
  projectName: string;
  rootPath: string;
  defaultBranch: string;
  createdAt: string;
};

export type StackInfo = {
  languages: string[];
  frameworks: string[];
  packageManager: string;
};

export type ScannedRepo = {
  sourceFiles: string[];
  allFiles: string[];
  areaPaths: string[];
};