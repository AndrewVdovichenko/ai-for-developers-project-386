import "@typespec/http";
import "@typespec/openapi3";
using TypeSpec.Http;
@service(#{ title: "Календарь звонков API" })
@server("http://127.0.0.1:3000", "Локальная разработка")
namespace Calendar;
@get
@route("/")
op getStatus(): { status: "ok" };
