/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { JoinRoadRoute } from "./JoinRoad.js";

afterEach(cleanup);

describe("JoinRoadRoute", () => {
  it("opens the live join gate at /join", () => {
    render(
      <MemoryRouter initialEntries={["/join"]}>
        <Routes>
          <Route path="/join" element={<JoinRoadRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Join a session" }),
    ).toBeTruthy();
  });
});
