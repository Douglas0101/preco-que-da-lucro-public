import { useState } from "react";
import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

describe("shadcn/Base UI contracts", () => {
  it("renders a semantic button and composes a link without nesting controls", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container, rerender } = render(<Button onClick={onClick}>Salvar</Button>);

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onClick).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);

    rerender(
      <Button render={<a href="/inicio" aria-label="Ir para o início" />}>Ir para o início</Button>,
    );

    expect(screen.getByRole("link", { name: "Ir para o início" })).toHaveAttribute(
      "href",
      "/inicio",
    );
    expect(container.querySelector("a button, button a")).not.toBeInTheDocument();
  });

  it("associates its label and changes a controlled Select with the keyboard", async () => {
    const user = userEvent.setup();

    function SelectExample() {
      const [value, setValue] = useState("mensal");
      return (
        <div>
          <Label htmlFor="periodo">Período</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mensal">Mensal</SelectItem>
              <SelectItem value="anual">Anual</SelectItem>
            </SelectContent>
          </Select>
          <output>{value}</output>
        </div>
      );
    }

    const { container } = render(<SelectExample />);
    const trigger = screen.getByRole("combobox", { name: "Período" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByText("anual", { selector: "output" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("traps Sheet focus, closes with Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Sheet>
        <SheetTrigger render={<Button />}>Abrir menu</SheetTrigger>
        <SheetContent>
          <SheetTitle>Menu principal</SheetTitle>
          <SheetDescription>Navegação da aplicação.</SheetDescription>
          <a href="/inicio">Início</a>
        </SheetContent>
      </Sheet>,
    );
    const trigger = screen.getByRole("button", { name: "Abrir menu" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Menu principal" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("requires an explicit AlertDialog action before running destructive work", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { container } = render(
      <AlertDialog>
        <AlertDialogTrigger render={<Button />}>Excluir produto</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir produto?</AlertDialogTitle>
            <AlertDialogDescription>Esta ação não poderá ser desfeita.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Confirmar exclusão
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Excluir produto" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Excluir produto?" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Confirmar exclusão" }));

    expect(onDelete).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
