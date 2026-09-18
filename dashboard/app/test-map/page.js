import { TestMap } from "@/components/test-map";
import { Connections } from "@/components/connections";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function TestMapPage() {
  return (
    <Tabs defaultValue="map">
      <TabsList>
        <TabsTrigger value="map">Test map</TabsTrigger>
        <TabsTrigger value="connections">Connections</TabsTrigger>
      </TabsList>
      <TabsContent value="map">
        <TestMap />
      </TabsContent>
      <TabsContent value="connections">
        <Connections />
      </TabsContent>
    </Tabs>
  );
}
