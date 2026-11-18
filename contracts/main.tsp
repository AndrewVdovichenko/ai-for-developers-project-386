import "@typespec/http";
import "@typespec/openapi3";
using TypeSpec.Http;
@service(#{ title: "Календарь звонков API" })
@server("http://127.0.0.1:3000", "Локальная разработка")
namespace Calendar;
@get
@route("/")
op getStatus(): { status: "ok" };

model Session {
  authenticated: boolean;
  expiresAt: string | null;
  serverNow: string;
}
model SessionStatus extends Session { configured: boolean; }
model ApiError {
  code: "INVALID_REQUEST" | "OWNER_AUTH_REQUIRED" | "INVALID_PASSWORD" | "ORIGIN_NOT_ALLOWED" | "OWNER_NOT_CONFIGURED" | "LOGIN_RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "INTERNAL_ERROR" | "VALIDATION_FAILED" | "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_KEY_REUSED" | "EVENT_TYPE_NOT_FOUND";
  message: string;
  fieldErrors?: { field: string; code: string; message: string }[];
  retryAfterSeconds?: int32;
}
model BadRequest { @statusCode statusCode: 400; @body body: ApiError; }
model Unauthorized { @statusCode statusCode: 401; @body body: ApiError; }
model Forbidden { @statusCode statusCode: 403; @body body: ApiError; }
model RateLimited { @statusCode statusCode: 429; @header("Retry-After") retryAfter: int32; @body body: ApiError; }
model Unavailable { @statusCode statusCode: 503; @body body: ApiError; }
model InternalError { @statusCode statusCode: 500; @body body: ApiError; }
@route("/api/owner/session")
namespace OwnerSession {
  @get op getOwnerSession(): SessionStatus | Unavailable | InternalError;
  @post op loginOwner(@body body: { password: string }): Session | BadRequest | Unauthorized | Forbidden | RateLimited | Unavailable | InternalError;
  @delete op logoutOwner(): NoContentResponse | Forbidden | Unavailable | InternalError;
}

model EventType {
  @format("uuid") id: string;
  name: string;
  description: string;
  durationMinutes: int32;
}
model CreateEventType {
  @doc("Название после trim: 1–100 кодовых точек; U+0000 запрещён.")
  @pattern("^[^\\u0000]*$") name: string;
  @doc("До 2000 кодовых точек; переносы сохраняются, U+0000 запрещён.")
  @pattern("^[^\\u0000]*$") description?: string;
  durationMinutes: int32;
}
model EventTypeCreated { eventType: EventType; }
model NotFound { @statusCode statusCode: 404; @body body: ApiError; }
model Conflict { @statusCode statusCode: 409; @body body: ApiError; }
model OperationResponse { status: int32; body: EventTypeCreated | ApiError; }
union OperationResult {
  { state: "unknown" },
  { state: "completed"; response: OperationResponse; }
}
@route("/api/event-types")
namespace EventTypes {
  @get op listEventTypes(): { items: EventType[] } | Unavailable | InternalError;
  @get @route("/{id}") op getEventType(@path id: string): EventType | NotFound | Unavailable | InternalError;
}
@route("/api/owner/event-types")
@post op createEventType(@header("Idempotency-Key") key: string, @body body: CreateEventType):
  { @statusCode statusCode: 201; @body body: EventTypeCreated } | BadRequest | Unauthorized | Forbidden | Conflict | Unavailable | InternalError;
@route("/api/owner/operations/{key}")
@get op getOwnerOperation(@path key: string): OperationResult | BadRequest | Unauthorized | Unavailable | InternalError;
