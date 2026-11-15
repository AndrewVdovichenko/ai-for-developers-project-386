import { MantineProvider } from '@mantine/core';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { BookingPage } from './pages/BookingPage';
import { HomePage } from './pages/HomePage';
import { theme } from './theme';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/booking', element: <BookingPage /> },
]);

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <RouterProvider router={router} />
    </MantineProvider>
  );
}
