import { describe, expect, it } from "vitest";
import {
  contactLinks, describeNotification, formatPhone, needsTelling, normalisePhone
} from "../src/shared/contact.js";

describe("phone numbers", () => {
  it("accepts a local Serbian number and gives it a country code", () => {
    expect(normalisePhone("064 123 4567")).toBe("+381641234567");
    expect(normalisePhone("0641234567")).toBe("+381641234567");
  });

  it("keeps a number that already has one", () => {
    expect(normalisePhone("+381 64 123 4567")).toBe("+381641234567");
    expect(normalisePhone("00381641234567")).toBe("+381641234567");
    expect(normalisePhone("381641234567")).toBe("+381641234567");
  });

  it("never keeps the trunk zero alongside the country code", () => {
    expect(normalisePhone("064 123 4567")).not.toContain("3810");
  });

  it("survives the ways people decorate a number", () => {
    expect(normalisePhone("(064) 123-45.67")).toBe("+381641234567");
  });

  it("takes a foreign number as given", () => {
    expect(normalisePhone("+49 151 12345678")).toBe("+4915112345678");
  });

  it("refuses what it cannot use rather than storing a broken number", () => {
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("   ")).toBeNull();
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone("064123")).toBeNull();          // too short
    expect(normalisePhone("+3816412345678901")).toBeNull(); // too long for E.164
    expect(normalisePhone("+381-64-ABC")).toBeNull();
  });

  it("formats for reading, not for dialling", () => {
    expect(formatPhone("0641234567")).toBe("+381 64 123 4567");
    expect(formatPhone("+4915112345678")).toBe("+4915112345678");
    expect(formatPhone(null)).toBe("");
  });
});

describe("contact links", () => {
  it("offers only the apps the client says they use", () => {
    const links = contactLinks("064 123 4567", ["whatsapp", "viber"]);
    expect(links.map(l => l.channel)).toEqual(["whatsapp", "viber"]);
  });

  it("gives each app the shape it wants", () => {
    const links = contactLinks("064 123 4567", ["whatsapp", "telegram", "viber"]);
    expect(links[0]!.href).toBe("https://wa.me/381641234567");      // bare digits
    expect(links[1]!.href).toBe("tg://resolve?phone=381641234567"); // app scheme
    expect(links[2]!.href).toBe("viber://chat?number=%2B381641234567"); // encoded plus
  });

  it("offers nothing without a usable number", () => {
    expect(contactLinks(null, ["whatsapp"])).toEqual([]);
    expect(contactLinks("nonsense", ["whatsapp"])).toEqual([]);
  });

  it("offers nothing when no app was named", () => {
    expect(contactLinks("0641234567", [])).toEqual([]);
    expect(contactLinks("0641234567", null)).toEqual([]);
  });

  it("ignores a channel it does not know", () => {
    expect(contactLinks("0641234567", ["signal", "whatsapp"]).map(l => l.channel))
      .toEqual(["whatsapp"]);
  });
});

describe("the outbox", () => {
  it("describes a same-day move once, not naming the date twice", () => {
    // 16:00Z and 15:00Z are 18:00 and 17:00 in Belgrade.
    expect(describeNotification(
      { kind: "lesson-moved", from: "2026-09-07T16:00:00.000Z", to: "2026-09-07T15:00:00.000Z" }
    )).toBe("Moved 18:00 → 17:00, Monday 7 September");
  });

  it("names both dates when the lesson moves to another day", () => {
    expect(describeNotification(
      { kind: "lesson-moved", from: "2026-09-07T16:00:00.000Z", to: "2026-09-08T16:00:00.000Z" }
    )).toBe("Moved 18:00 Monday 7 September → 18:00 Tuesday 8 September");
  });

  it("only asks the coach to pass on what the client cannot already see", () => {
    expect(needsTelling("lesson-moved")).toBe(true);
    expect(needsTelling("lesson-cancelled-by-coach")).toBe(true);
    // They pressed the button themselves — telling them is noise.
    expect(needsTelling("booking-confirmed")).toBe(false);
    expect(needsTelling("booking-cancelled")).toBe(false);
  });
});
