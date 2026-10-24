/**
 * Overclock TypeScript SDK: a client for the engine HTTP API (runs, live event streams, results)
 * and the arena admin API (scenarios and ground-truth checks). Contract types are re-exported so
 * one import covers both.
 */

export { Overclock, validateRunConfig, DEFAULT_ENGINE_URL, type OverclockOptions, type StreamOptions, type FollowOptions, type ControlResponse } from "./engine";
export { Arena, configFromScenario, DEFAULT_ARENA_URL, type ArenaOptions, type ScenarioRequestInput } from "./arena";
export { OverclockError, type OverclockErrorCode, type OverclockErrorOptions } from "./errors";
export { SseParser, readSseMessages, type SseMessage } from "./sse";

export { RunConfigSchema, createRunView, applyEvent, deriveMetrics, stageOverlapMs } from "@overclock/contracts";
export type {
  AppBinding,
  CheckResult,
  ConcurrencyMode,
  CreateRunResponse,
  EngineHealth,
  EventOf,
  EventPayload,
  EventType,
  EventsPage,
  ExecutionMode,
  FieldMismatch,
  IntelligenceMode,
  PublicScenario,
  RecordOutcome,
  RunConfig,
  RunConfigInput,
  RunEvent,
  RunListItem,
  RunResultResponse,
  RunStatus,
  RunStatusResponse,
  RunSummary,
  RunView,
  StageName,
  ScenarioRequest,
  TaskState,
  TaskTemplateId,
  VariationConfig,
  VerificationStatus,
} from "@overclock/contracts";
