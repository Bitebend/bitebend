import { Switch, Route, Router as WouterRouter } from "wouter";
import { LocationProvider } from "@/context/LocationContext";
import HomePage from "@/pages/HomePage";
import RestaurantPlatformPage from "@/pages/RestaurantPlatformPage";
import MessagingPlatformPage from "@/pages/MessagingPlatformPage";
import ScannerPage from "@/pages/ScannerPage";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <LocationProvider>
      <WouterRouter base="/">
        <Switch>
          {/* Bitebend Public Platform Routes */}
          <Route path="/" component={HomePage} />
          <Route path="/restaurant" component={RestaurantPlatformPage} />
          <Route path="/messaging" component={MessagingPlatformPage} />
          <Route path="/scanner" component={ScannerPage} />

          {/* 404 Fallback */}
          <Route component={NotFound} />
        </Switch>
      </WouterRouter>
    </LocationProvider>
  );
}
