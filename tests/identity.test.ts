import { describe, expect, it } from "vitest";
import {
  checkSignIn, displayNameFrom, normaliseName, personIsListed
} from "../src/shared/identity.js";

describe("matching names", () => {
  it("ignores case and padding", () => {
    expect(normaliseName("  Nemanja  ")).toBe("nemanja");
    expect(normaliseName("NEMANJA")).toBe(normaliseName("nemanja"));
  });

  it("collapses doubled spaces", () => {
    expect(normaliseName("Nemanja   Petrovic")).toBe("nemanja petrovic");
  });

  it("folds Serbian diacritics, because a foreign keyboard cannot type them", () => {
    expect(normaliseName("Miloš")).toBe("milos");
    expect(normaliseName("Đorđe")).toBe("dorde");
    expect(normaliseName("Ćirić")).toBe("ciric");
    expect(normaliseName("Živko")).toBe("zivko");
    expect(normaliseName("Miloš")).toBe(normaliseName("Milos"));
  });

  it("still tells different people apart", () => {
    expect(normaliseName("Milan")).not.toBe(normaliseName("Milana"));
  });
});

describe("display names", () => {
  it("tidies spacing and capitalisation without rewriting the name", () => {
    expect(displayNameFrom("  nemanja ", "petrOVIĆ")).toBe("Nemanja Petrović");
  });

  it("keeps a double-barrelled surname readable", () => {
    expect(displayNameFrom("Ana", "petrovic-jovanovic")).toBe("Ana Petrovic-Jovanovic");
  });

  it("copes with a missing half rather than leaving a stray space", () => {
    expect(displayNameFrom("Karina", "")).toBe("Karina");
    expect(displayNameFrom("", "")).toBe("");
  });
});

describe("who is on a record", () => {
  const people = [{ name: "Nemanja Petrović" }, { name: "Ivana Petrović" }];

  it("recognises someone already listed, however they type it", () => {
    expect(personIsListed(people, "nemanja petrovic")).toBe(true);
    expect(personIsListed(people, "  IVANA   Petrović ")).toBe(true);
  });

  it("does not recognise a stranger", () => {
    expect(personIsListed(people, "Milan Jovanović")).toBe(false);
    expect(personIsListed([], "Nemanja Petrović")).toBe(false);
    expect(personIsListed(null, "Nemanja Petrović")).toBe(false);
  });
});

describe("what the form needs", () => {
  it("asks for both halves of the name", () => {
    expect(checkSignIn({ firstName: "", lastName: "Petrovic" })).toBe("no-first-name");
    expect(checkSignIn({ firstName: "Nemanja", lastName: "  " })).toBe("no-last-name");
    expect(checkSignIn({ firstName: "Nemanja", lastName: "Petrovic" })).toBeNull();
  });
});
