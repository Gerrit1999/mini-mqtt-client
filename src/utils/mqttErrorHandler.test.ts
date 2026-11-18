import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, ErrorType } from "./errorHandler";
import {
  validateMqttTopic,
  validateSubscribeTopic,
  handleMqttError,
  getMqttErrorSuggestion,
} from "./mqttErrorHandler";

describe("MQTT topic validation", () => {
  it("rejects empty, NUL-containing, and oversized topics", () => {
    expect(validateMqttTopic("").valid).toBe(false);
    expect(validateMqttTopic("sensor\0value").valid).toBe(false);
    expect(validateMqttTopic("é".repeat(32768)).valid).toBe(false);
    expect(validateMqttTopic("a".repeat(65535)).valid).toBe(true);
  });

  it("requires subscription wildcards to occupy complete levels", () => {
    for (const topic of ["sensors/+", "sensors/#", "#"]) {
      expect(validateSubscribeTopic(topic).valid).toBe(true);
    }
    for (const topic of ["sensors/+temperature", "sensors/temperature+", "sensors/#/raw", "sensors#"]) {
      expect(validateSubscribeTopic(topic).valid).toBe(false);
    }
  });
});

describe("MQTT OS error fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [10061, "由于目标计算机积极拒绝，无法连接。", "CONNECTION_REFUSED"],
    [10060, "连接尝试失败，连接的主机没有反应。", "CONNECTION_TIMEOUT"],
    [10054, "远程主机强迫关闭了一个现有的连接。", "CONNECTION_RESET"],
    [10053, "你的主机中的软件中止了一个已建立的连接。", "DISCONNECTED"],
    [11001, "不知道这样的主机。", "DNS_ERROR"],
    [11002, "主机名解析中发生临时错误。", "DNS_ERROR"],
    [11003, "主机名解析中发生不可恢复的错误。", "DNS_ERROR"],
    [11004, "请求的名称有效，但是没有找到请求的类型的数据。", "DNS_ERROR"],
  ])("classifies Windows socket error %i with localized text", (number, text, code) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const info = handleMqttError(`Failed to connect: I/O: ${text} (os error ${number})`, true);
    expect(info.code).toBe(code);
    expect(getMqttErrorSuggestion(code)).toBe(info.suggestion);
  });

  it.each([
    ["Win32", 111, "UNKNOWN"],
    ["Linux x86_64", 111, "CONNECTION_REFUSED"],
    ["Linux x86_64", 110, "CONNECTION_TIMEOUT"],
    ["Linux x86_64", 60, "UNKNOWN"],
    ["Linux x86_64", 10061, "UNKNOWN"],
    ["Linux x86_64", 11001, "UNKNOWN"],
    ["MacIntel", 61, "CONNECTION_REFUSED"],
    ["MacIntel", 60, "CONNECTION_TIMEOUT"],
    ["MacIntel", 110, "UNKNOWN"],
    ["MacIntel", 11001, "UNKNOWN"],
    ["", 10061, "UNKNOWN"],
  ])("on %s interprets raw code %i as %s", (platform, number, code) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    expect(handleMqttError(`I/O: 连接失败 (os error ${number})`, true).code).toBe(code);
  });

  it.each([
    ["I/O: 拒绝访问。 (os error 5)", "UNKNOWN"],
    ["I/O: 无法连接到端口 10061", "UNKNOWN"],
    ["I/O: 无法连接 (os error 100610)", "UNKNOWN"],
    ["Unsupported MQTT protocol version (os error 10061)", "PROTOCOL_ERROR"],
    ["Authentication error (os error 10061)", "AUTH_FAILED"],
    ["Connection refused: BadUserNamePassword (os error 10060)", "CONNECTION_REFUSED"],
    ["I/O: connection timed out (os error 10061)", "UNKNOWN"],
    ["TLS: invalid peer certificate (os error 10061)", "UNKNOWN"],
  ])("preserves existing text handling for %s", (error, code) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const info = handleMqttError(error, true);
    expect(info.code).toBe(code);
    if (code === "UNKNOWN") expect(info.message).toBe(error);
  });

  it("forwards the original OS error and request context", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const spy = vi.spyOn(errorHandler, "handle").mockReturnValue({
      type: ErrorType.MQTT, message: "连接被拒绝", timestamp: new Date(),
    });
    const reason = "I/O: 由于目标计算机积极拒绝，无法连接。 (os error 10061)";
    const context = { serverId: 7 };
    handleMqttError(reason, false, context);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CONNECTION_REFUSED", reason }),
      ErrorType.MQTT, false, context,
    );
  });
});

describe("MQTT error forwarding", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["connection refused: broker A", "unexpected broker failure"])(
    "forwards the original reason and request context for %s", (reason) => {
      const spy = vi.spyOn(errorHandler, "handle").mockReturnValue({} as any);
      const context = { serverId: 7, topic: "device/a", command: "publish_message" };
      handleMqttError(reason, false, context);
      expect(spy).toHaveBeenCalledWith(
        reason.startsWith("connection") ? expect.objectContaining({ reason }) : reason,
        ErrorType.MQTT, false, context
      );
      spy.mockRestore();
    }
  );

  it("preserves the existing silent boolean behavior", () => {
    const spy = vi.spyOn(errorHandler, "handle").mockReturnValue({} as any);
    handleMqttError("timeout", true);
    handleMqttError("unknown", true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
