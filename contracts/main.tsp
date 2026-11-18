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
  code: "INVALID_REQUEST" | "OWNER_AUTH_REQUIRED" | "INVALID_PASSWORD" | "ORIGIN_NOT_ALLOWED" | "OWNER_NOT_CONFIGURED" | "LOGIN_RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "INTERNAL_ERROR";
  message: string;
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
