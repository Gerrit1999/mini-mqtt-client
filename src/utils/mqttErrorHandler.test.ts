import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, ErrorType } from "./errorHandler";
import {
  validateMqttTopic,
  validateSubscribeTopic,
  handleMqttError,
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
