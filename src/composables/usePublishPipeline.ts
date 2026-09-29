import { useMqttStore } from "@/stores/mqtt";
import { ScriptEngine } from "@/utils/scriptEngine";
import { getCachedScripts } from "@/utils/scriptCache";
import { replaceEnvVariables } from "@/utils/envReplacer";
import { handleScriptError } from "@/utils/errorHandler";
import { decodePayload } from "@/utils/payloadCodec";
import type { PayloadFormat } from "@/types/mqtt";

export interface PublishRequest {
  serverId: number;
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  format: PayloadFormat;
}

export interface PublishResult {
  success: boolean;
  topic: string;
  payload: string;
  error?: string;
  scriptError?: string;
}

/**
 * Shared publish processing for manual, timed, and scheduled sends.
 * A before-publish script failure returns before publishTrackedMessage is called.
 */
export function usePublishPipeline() {
  const mqttStore = useMqttStore();

  async function publish(request: PublishRequest): Promise<PublishResult> {
    const seq = mqttStore.reserveSeq();
    const envVariables = await mqttStore.getCachedEnvVariables(request.serverId);
    const topic = replaceEnvVariables(request.topic, envVariables);
    let payload = replaceEnvVariables(request.payload, envVariables);

    try {
      const scripts = await getCachedScripts(request.serverId, "before_publish");
      if (scripts.length > 0) {
        payload = await ScriptEngine.executeBeforePublish(
          scripts,
          payload,
          topic,
          envVariables
        );
        decodePayload(payload, request.format);
      }
    } catch (error) {
      const scriptError = error instanceof Error ? error.message : String(error);
      handleScriptError(error);
      try {
        mqttStore.addPublishMessage(request.serverId, {
          topic,
          payload: request.payload,
          qos: request.qos,
          retain: request.retain,
          scriptError,
          payload_type: request.format,
          seq,
        });
      } catch (displayError) {
        console.warn("Failed to record publish script error:", displayError);
      }
      return { success: false, topic, payload: request.payload, error: scriptError, scriptError };
    }

    try {
      await mqttStore.publishTrackedMessage(request.serverId, {
        topic,
        payload,
        qos: request.qos,
        retain: request.retain,
        format: request.format,
        seq,
      });
      return { success: true, topic, payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, topic, payload, error: message };
    }
  }

  return { publish };
}
