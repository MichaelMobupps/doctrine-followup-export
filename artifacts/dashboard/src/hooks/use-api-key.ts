import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import React from "react";

interface ApiKeyContextValue {
  apiKey: string | null;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;
  isLoaded: boolean;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyContextProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyValue] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("doctrine_api_key");
    if (stored) {
      setApiKeyValue(stored);
    }
    setIsLoaded(true);
  }, []);

  const setApiKey = (key: string) => {
    localStorage.setItem("doctrine_api_key", key);
    setApiKeyValue(key);
  };

  const clearApiKey = () => {
    localStorage.removeItem("doctrine_api_key");
    setApiKeyValue(null);
  };

  return React.createElement(
    ApiKeyContext.Provider,
    { value: { apiKey, setApiKey, clearApiKey, isLoaded } },
    children
  );
}

export function useApiKey(): ApiKeyContextValue {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) {
    throw new Error("useApiKey must be used within an ApiKeyContextProvider");
  }
  return ctx;
}
