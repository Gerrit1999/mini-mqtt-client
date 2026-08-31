import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MessagePayload from "./MessagePayload.vue";

describe("MessagePayload JSON formatting", () => {
  function formattedPayload(payload: string) {
    const wrapper = mount(MessagePayload, {
      props: {
        payload,
        payloadType: "json",
        formatJson: true,
        preview: true,
      },
    });

    return wrapper.find("pre").text();
  }

  it("preserves integer literals outside JavaScript's safe range", () => {
    expect(formattedPayload('{"id":9223372036854775807}')).toBe(
      '{\n  "id": 9223372036854775807\n}'
    );
  });

  it("preserves numeric literals in nested JSON values", () => {
    expect(formattedPayload('{"values":[2.370,2.3e+500,-9223372036854775808]}')).toBe(
      '{\n  "values": [\n    2.370,\n    2.3e+500,\n    -9223372036854775808\n  ]\n}'
    );
  });

  it("falls back to the original payload when JSON is invalid", () => {
    expect(formattedPayload('{"id":9223372036854775807')).toBe(
      '{"id":9223372036854775807'
    );
  });
});
