import { describe, expect, it } from "vitest";
import {
  validateMqttTopic,
  validateSubscribeTopic,
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
