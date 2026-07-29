# Skill: shadcn/ui Components

Add and configure shadcn/ui components in a Next.js or React project.

## When to use
When the user wants to add UI components (buttons, dialogs, cards, forms, tables, etc.) using shadcn/ui — the copy-paste component library built on Radix UI and Tailwind CSS.

## Setup (first time only)

Initialize shadcn in the work/project root (where package.json lives):
```bash
npx shadcn@latest init
```

This creates `components.json` and sets up `src/components/ui/`. Answer the prompts to match your project's style preferences.

## Add a component

```bash
npx shadcn@latest add <component-name>
```

## Add multiple components at once
```bash
npx shadcn@latest add button card dialog input form
```

## Commonly used components

| Component | Install name | Description |
|-----------|-------------|-------------|
| Button | `button` | Clickable button with variants |
| Card | `card` | Container with header/content/footer |
| Input | `input` | Text input field |
| Label | `label` | Form label |
| Textarea | `textarea` | Multi-line text input |
| Select | `select` | Dropdown select |
| Checkbox | `checkbox` | Checkbox with label |
| Switch | `switch` | Toggle switch |
| Dialog | `dialog` | Modal dialog |
| Sheet | `sheet` | Slide-in panel (drawer) |
| Popover | `popover` | Floating content panel |
| Tooltip | `tooltip` | Hover tooltip |
| Dropdown Menu | `dropdown-menu` | Contextual dropdown |
| Command | `command` | Command palette / search |
| Badge | `badge` | Small status indicator |
| Avatar | `avatar` | User avatar with fallback |
| Separator | `separator` | Visual divider |
| Table | `table` | Data table |
| Tabs | `tabs` | Tabbed interface |
| Accordion | `accordion` | Collapsible sections |
| Sonner | `sonner` | Toast notifications (preferred over toast) |
| Alert | `alert` | Inline alert message |
| Alert Dialog | `alert-dialog` | Confirmation dialog |
| Progress | `progress` | Progress bar |
| Skeleton | `skeleton` | Loading placeholder |
| Scroll Area | `scroll-area` | Custom scrollbar container |
| Calendar | `calendar` | Date picker calendar |
| Form | `form` | React Hook Form integration |
| Slider | `slider` | Range slider |
| Toggle | `toggle` | Toggle button |
| Navigation Menu | `navigation-menu` | Site navigation |
| Breadcrumb | `breadcrumb` | Page navigation breadcrumbs |
| Collapsible | `collapsible` | Expandable/collapsible section |
| Context Menu | `context-menu` | Right-click context menu |
| Menubar | `menubar` | Application menu bar |
| Resizable | `resizable` | Resizable panel groups |

## Import pattern

```tsx
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
```

## Example — Button variants

```tsx
<Button>Default</Button>
<Button variant="destructive">Delete</Button>
<Button variant="outline">Cancel</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="link">Link</Button>
<Button size="sm">Small</Button>
<Button size="lg">Large</Button>
<Button disabled>Disabled</Button>
```

## Example — Card

```tsx
<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description goes here</CardDescription>
  </CardHeader>
  <CardContent>
    <p>Card content here</p>
  </CardContent>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>
```

## Example — Form with validation (React Hook Form + Zod)

```bash
npx shadcn@latest add form input
npm install zod react-hook-form @hookform/resolvers
```

```tsx
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const formSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

export function LoginForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "" },
  })

  function onSubmit(values: z.infer<typeof formSchema>) {
    console.log(values)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full">Sign in</Button>
      </form>
    </Form>
  )
}
```

## Example — Toast notifications (Sonner)

```bash
npx shadcn@latest add sonner
```

```tsx
// In your root layout — add the Toaster once
import { Toaster } from "@/components/ui/sonner"
export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  )
}

// Then anywhere in your app
import { toast } from "sonner"

toast("Event created")
toast.success("Profile saved")
toast.error("Something went wrong")
toast.promise(saveData(), {
  loading: "Saving...",
  success: "Saved!",
  error: "Failed to save",
})
```

## The cn() utility

shadcn uses `clsx` + `tailwind-merge` via a `cn()` helper for conditional classes:

```tsx
import { cn } from "@/lib/utils"

<div className={cn("base-class", isActive && "active-class", className)} />
```

## Notes
- Components are **copied into your project** (not a node_modules dependency) — edit them freely
- Requires **Tailwind CSS** configured in the project
- Uses **Radix UI** primitives for accessibility
- Components land in `src/components/ui/` by default
- Run `npx shadcn@latest diff` to see if upstream components have changed
- Check `components.json` for path and style config
- Use Sonner (`sonner`) instead of the legacy `toast` component for notifications
