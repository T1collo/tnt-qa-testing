import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TEST_ID_MAP } from "@/lib/testIdMap";

type TestMapRow = { testId: string; role: string; eventType: string; path: string[] };

const ROLE_LABEL: Record<string, string> = {
  manufacturer: "Manufacturer",
  distributor: "Distributor",
  facility: "Facility",
};

export function TestMap() {
  const rows: TestMapRow[] = [...TEST_ID_MAP].sort(
    (a, b) => a.role.localeCompare(b.role) || a.testId.localeCompare(b.testId)
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        What the runner actually fires for each workbook Test ID — sourced directly from{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">lib/testIdMap.js</code>, the same
        file the run engine and the Excel export both use, so this list can&apos;t drift out of sync.
      </p>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Event type</TableHead>
                <TableHead>Workbook Test ID</TableHead>
                <TableHead>Postman collection path</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={`${row.testId}-${row.role}-${i}`}>
                  <TableCell className="text-muted-foreground">
                    {ROLE_LABEL[row.role] || row.role}
                  </TableCell>
                  <TableCell>{row.eventType}</TableCell>
                  <TableCell className="font-mono text-xs">{row.testId}</TableCell>
                  <TableCell className="whitespace-normal font-mono text-xs text-muted-foreground">
                    {row.path.join(" > ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default TestMap;
